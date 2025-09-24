#!/usr/bin/env node

import express, { Request, Response } from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as azdev from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { getOrgTenant } from "./org-tenants.js";
import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";

// ----------------- ENV -----------------
function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}
const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// ----------------- CLI ARGS -----------------
const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization> [options]")
  .version(packageVersion)
  // Make organization a required option, fallback for positional
  .option("organization", {
    alias: "o",
    type: "string",
    describe: "Azure DevOps organization name",
    demandOption: true,
  })
  .option("domains", {
    alias: "d",
    describe:
      "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication: 'interactive', 'azcli', 'env', 'obo'. Default: interactive",
    type: "string",
    choices: ["interactive", "azcli", "env", "obo"],
    default: defaultAuthenticationType,
  })
  .option("tenant", { alias: "t", type: "string", describe: "Azure tenant ID" })
  .option("transport", { alias: "x", type: "string", choices: ["stdio", "http"], default: "stdio" })
  .option("port", { alias: "p", type: "number", default: 3000 })
  .help()
  .parseSync();

// Fallback: if user provided first positional arg, treat it as organization
if (!argv.organization && process.argv[2] && !process.argv[2].startsWith("-")) {
  argv.organization = process.argv[2];
}

console.log("Using organization:", argv.organization);

export const orgName = argv.organization as string;
export const orgUrl = `https://dev.azure.com/${orgName}`;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

// ----------------- AZURE DEVOPS CLIENT -----------------
function getAzureDevOpsClient(
  getAzureDevOpsToken: (userAssertion?: string) => Promise<string>,
  userAgentComposer: UserAgentComposer
): (userAssertion?: string) => Promise<azdev.WebApi> {
  return async (userAssertion?: string) => {
    const accessToken = await getAzureDevOpsToken(userAssertion);
    const authHandler = azdev.getBearerHandler(accessToken);
    return new azdev.WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
  };
}

// ----------------- HELPER -----------------
function isInitializeBody(body: any): boolean {
  return body && body.method === "initialize";
}

// ----------------- MAIN -----------------
async function main() {
  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  const tenantId = (await getOrgTenant(orgName)) ?? argv.tenant;

  // ----------------- AUTHENTICATOR -----------------
  let authenticator: (userAssertion?: string) => Promise<string>;
  if (argv.authentication === "obo") {
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "OBO authentication requires AZURE_CLIENT_ID and AZURE_CLIENT_SECRET environment variables."
      );
    }
    authenticator = createAuthenticator("obo", tenantId, { clientId, clientSecret });
  } else {
    authenticator = createAuthenticator(argv.authentication, tenantId);
  }

  // ----------------- CONFIGURE TOOLS -----------------
  configurePrompts(server);
  configureAllTools(
    server,
    authenticator,
    getAzureDevOpsClient(authenticator, userAgentComposer),
    () => userAgentComposer.userAgent,
    enabledDomains
  );

  // ----------------- TRANSPORT -----------------
  if (argv.transport === "http") {
    const app = express();
    app.use(express.json());

    // Map of sessionId => transport
    const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req: Request, res: Response) => {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      console.log("Body received:", req.body);
      console.log("isInitializeBody:", isInitializeBody(req.body));

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeBody(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sessionId) => {
            
            transports[sessionId] = transport;
          },
          // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
          // locally, make sure to set:
          // enableDnsRebindingProtection: true,
          // allowedHosts: ['127.0.0.1'],
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        

        // ... set up server resources, tools, and prompts ...

        // Connect to the MCP server
        await server.connect(transport);
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });



    // GET / DELETE handler
    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
      };

    app.get("/mcp", handleSessionRequest);
    app.delete("/mcp", handleSessionRequest);

    app.listen(argv.port, () =>
      console.log(`MCP HTTP server running on port ${argv.port} (streamable)`)
    );
  } else {
    const transport = new StdioServerTransport();
    console.log("MCP server running over stdio");
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
