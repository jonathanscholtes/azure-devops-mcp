import { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { AccountInfo, AuthenticationResult, PublicClientApplication } from "@azure/msal-node";
import open from "open";

const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];

class OAuthAuthenticator {
  static clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";
  static defaultAuthority = "https://login.microsoftonline.com/common";

  private accountId: AccountInfo | null;
  private publicClientApp: PublicClientApplication;

  constructor(tenantId?: string) {
    this.accountId = null;
    this.publicClientApp = new PublicClientApplication({
      auth: {
        clientId: OAuthAuthenticator.clientId,
        authority: tenantId ? `https://login.microsoftonline.com/${tenantId}` : OAuthAuthenticator.defaultAuthority,
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
      } catch (error) {
        authResult = null;
      }
    }
    if (!authResult) {
      authResult = await this.publicClientApp.acquireTokenInteractive({
        scopes,
        openBrowser: async (url) => {
          open(url);
        },
      });
      this.accountId = authResult.account;
    }

    if (!authResult.accessToken) {
      throw new Error("Failed to obtain Azure DevOps OAuth token.");
    }
    return authResult.accessToken;
  }
}

function createAuthenticator(
  type: string,
  tenantId?: string
): (externalToken?: string) => Promise<string> {
  switch (type) {
    case "azcli":
    case "env": {
      let credential: TokenCredential = new DefaultAzureCredential();
      if (tenantId) {
        const azureCliCredential = new AzureCliCredential({ tenantId });
        credential = new ChainedTokenCredential(azureCliCredential, credential);
      }
      return async () => {
        const result = await credential.getToken(scopes);
        if (!result) throw new Error("Failed to obtain Azure DevOps token.");
        return result.token;
      };
    }

    case "external": {
      return async (externalToken?: string) => {
        if (!externalToken) {
          throw new Error("External token must be provided for 'external' auth type.");
        }
        return externalToken;
      };
    }

    default: {
      const authenticator = new OAuthAuthenticator(tenantId);
      return () => authenticator.getToken();
    }
  }
}
export { createAuthenticator };