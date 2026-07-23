import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import { PluginAuthError } from "./errors";
import { validateOidcClaims } from "./oidc-validation";
import type {
  OidcExchangeRequest,
  PluginOidcExchange,
  VerifiedPluginIdentity,
} from "./types";

export class GooglePluginOidcExchange implements PluginOidcExchange {
  private readonly oauthClient: PluginGoogleOAuthClient;

  public constructor(input: {
    clientId: string;
    clientSecret: string;
    callbackUri: string;
    oauthClient?: PluginGoogleOAuthClient;
  }) {
    this.oauthClient =
      input.oauthClient ??
      new GoogleOAuthClientAdapter(
        new OAuth2Client({
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          redirectUri: input.callbackUri,
        }),
      );
  }

  public createAuthorizationUrl(input: {
    state: string;
    nonce: string;
    pkceChallenge: string;
  }): string {
    return this.oauthClient.generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email", "profile"],
      state: input.state,
      code_challenge: input.pkceChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      nonce: input.nonce,
      include_granted_scopes: false,
    });
  }

  public async exchangeAndVerify(
    request: OidcExchangeRequest,
  ): Promise<VerifiedPluginIdentity> {
    try {
      const tokenResponse = await this.oauthClient.getToken({
        code: request.authorizationCode,
        codeVerifier: request.pkceVerifier,
        redirect_uri: request.callbackUri,
      });
      const idToken = tokenResponse.tokens.id_token;
      if (!idToken) {
        throw new Error("OIDC ID token missing");
      }
      const ticket = await this.oauthClient.verifyIdToken({
        idToken,
        audience: request.expectedAudience,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        throw new Error("OIDC payload missing");
      }
      return validateOidcClaims(payload as unknown as Record<string, unknown>, {
        allowedIssuers: request.allowedIssuers,
        audience: request.expectedAudience,
        nonce: request.expectedNonce,
        companyDomain: request.companyDomain,
      });
    } catch {
      throw new PluginAuthError(
        "COMPANY_IDENTITY_REJECTED",
        "Company account verification failed",
      );
    }
  }
}

interface PluginGoogleOAuthClient {
  generateAuthUrl(options: Record<string, unknown>): string;
  getToken(options: {
    code: string;
    codeVerifier: string;
    redirect_uri: string;
  }): Promise<{ tokens: { id_token?: string | null } }>;
  verifyIdToken(options: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): object | undefined }>;
}

class GoogleOAuthClientAdapter implements PluginGoogleOAuthClient {
  public constructor(private readonly client: OAuth2Client) {}

  public generateAuthUrl(options: Record<string, unknown>): string {
    return this.client.generateAuthUrl(
      options as Parameters<OAuth2Client["generateAuthUrl"]>[0],
    );
  }

  public async getToken(options: {
    code: string;
    codeVerifier: string;
    redirect_uri: string;
  }): Promise<{ tokens: { id_token?: string | null } }> {
    const response = await this.client.getToken(options);
    return { tokens: { id_token: response.tokens.id_token } };
  }

  public async verifyIdToken(options: {
    idToken: string;
    audience: string;
  }): Promise<{ getPayload(): object | undefined }> {
    return this.client.verifyIdToken(options);
  }
}
