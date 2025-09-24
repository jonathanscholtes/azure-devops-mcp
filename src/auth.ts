import { 
  AzureCliCredential, 
  ChainedTokenCredential, 
  DefaultAzureCredential, 
  TokenCredential 
} from "@azure/identity";
import { 
  AccountInfo, 
  AuthenticationResult, 
  PublicClientApplication, 
  ConfidentialClientApplication 
} from "@azure/msal-node";
import open from "open";

const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];

// ----------------- OAuth Authenticator -----------------
export class OAuthAuthenticator {
  static clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";
  static defaultAuthority = "https://login.microsoftonline.com/common";

  private accountId: AccountInfo | null = null;
  private publicClientApp: PublicClientApplication;

  constructor(tenantId?: string) {
    this.publicClientApp = new PublicClientApplication({
      auth: {
        clientId: OAuthAuthenticator.clientId,
        authority: tenantId
          ? `https://login.microsoftonline.com/${tenantId}`
          : OAuthAuthenticator.defaultAuthority,
      },
    });
  }

  public async getToken(): Promise<string> {
    let authResult: AuthenticationResult | null = null;

    if (this.accountId) {
      try {
        authResult = await this.publicClientApp.acquireTokenSilent({
          scopes,
          account: this.accountId,
        });
      } catch {
        authResult = null;
      }
    }

    if (!authResult) {
      authResult = await this.publicClientApp.acquireTokenInteractive({
        scopes,
        openBrowser: async (url: string): Promise<void> => {
          await open(url);
        },
      });
      this.accountId = authResult.account;
    }

    if (!authResult?.accessToken) {
      throw new Error("Failed to obtain Azure DevOps OAuth token.");
    }
    return authResult.accessToken;
  }
}

// ----------------- OBO Authenticator -----------------
export class OboAuthenticator {
  private cca: ConfidentialClientApplication;

  constructor(clientId: string, clientSecret: string, tenantId: string) {
    this.cca = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret,
      },
    });
  }

  // userAssertion = incoming user token (from Authorization header)
  public async getToken(userAssertion: string): Promise<string> {
    const result = await this.cca.acquireTokenOnBehalfOf({
      scopes,
      oboAssertion: userAssertion,
    });

    if (!result?.accessToken) {
      throw new Error("Failed to obtain Azure DevOps token via OBO.");
    }
    return result.accessToken;
  }
}

// ----------------- Authenticator Factory -----------------
export function createAuthenticator(
  type: string,
  tenantId?: string,
  options?: { clientId?: string; clientSecret?: string; userAssertion?: string }
): (userAssertion?: string) => Promise<string> {
  switch (type) {
    case "obo":
      if (!options?.clientId || !options?.clientSecret || !options?.userAssertion) {
        throw new Error("OBO requires clientId, clientSecret, and userAssertion.");
      }
      const oboAuth = new OboAuthenticator(
        options.clientId,
        options.clientSecret,
        tenantId || "common"
      );
      return () => oboAuth.getToken(options.userAssertion!);

    case "azcli":
    case "env":
      if (type !== "env") {
        process.env.AZURE_TOKEN_CREDENTIALS = "dev";
      }
      let credential: TokenCredential = new DefaultAzureCredential();
      if (tenantId) {
        const azureCliCredential = new AzureCliCredential({ tenantId });
        credential = new ChainedTokenCredential(azureCliCredential, credential);
      }
      return async () => {
        const result = await credential.getToken(scopes);
        if (!result) {
          throw new Error(
            "Failed to obtain Azure DevOps token. Ensure Azure CLI is logged in or use interactive authentication."
          );
        }
        return result.token;
      };

    default:
      const oauthAuth = new OAuthAuthenticator(tenantId);
      return () => oauthAuth.getToken();
  }
}
