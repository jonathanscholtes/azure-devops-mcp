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

import dotenv from "dotenv";
dotenv.config();

console.log("AZURE_CLIENT_ID:", process.env.AZURE_CLIENT_ID);

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
    describe: "Type of authentication: 'interactive', 'azcli', 'env', 'external', 'obo'. Default: interactive",
    type: "string",
    choices: ["interactive", "azcli", "env", "external", "obo"],
    default: defaultAuthenticationType,
  })
  .option("tenant", { alias: "t", type: "string", describe: "Azure tenant ID" })
  .option("transport", { alias: "x", type: "string", choices: ["stdio", "http"], default: "stdio" })
  .option("port", { alias: "p", type: "number", default: 3000 })
  .help()
  .parseSync();

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
  let externalToken: string | undefined;

  // Token provider for external auth
  const tokenProvider = async () => {
    if (!externalToken) {
      throw new Error("External token must be provided for 'external' auth type.");
    }
    return externalToken;
  };

  // ----------------- AUTHENTICATOR -----------------
  let authenticator: (userAssertion?: string) => Promise<string>;

  if (argv.authentication === "external") {
    authenticator = tokenProvider;
  } else if (argv.authentication === "obo") {
    if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET) {
      throw new Error(
        "OBO authentication requires AZURE_CLIENT_ID and AZURE_CLIENT_SECRET environment variables."
      );
    }
    authenticator = createAuthenticator("obo", argv.tenant, {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
    });
  } else {
    authenticator = createAuthenticator(argv.authentication, argv.tenant);
  }

  // ----------------- WRAP AUTHENTICATOR for per-request token -----------------
  const originalAuthenticator = authenticator;
  authenticator = async (userAssertion?: string) => {
    if (userAssertion) return originalAuthenticator(userAssertion);
    if (externalToken) return originalAuthenticator(externalToken);
    return originalAuthenticator();
  };

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

    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.post("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let userAssertion: string | undefined;

      if (argv.authentication === "external") {
        externalToken = req.headers["authorization"]?.split(" ")[1];

      } else if (argv.authentication === "obo") {
        userAssertion = req.headers["authorization"]?.split(" ")[1];
        if (!userAssertion) {
          res.status(400).json({ error: "User token required for OBO authentication" });
          return;
        }
        externalToken = userAssertion; // used in wrapped authenticator
      }

      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeBody(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sessionId) => {
            transports[sessionId] = transport;
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        if (argv.authentication === "obo") externalToken = undefined;
      }
    });

    const handleSessionRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
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
