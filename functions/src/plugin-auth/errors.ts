export type PluginAuthErrorCode =
  | "INVALID_REQUEST"
  | "PAIRING_UNAVAILABLE"
  | "POLL_RATE_LIMITED"
  | "COMPANY_IDENTITY_REJECTED"
  | "INVALID_DEVICE_CREDENTIAL"
  | "BINDING_REVOKED"
  | "PRINCIPAL_DISABLED"
  | "ROTATION_UNAVAILABLE"
  | "LEASE_INVALID"
  | "LEASE_EXPIRED"
  | "BINDING_MISMATCH"
  | "AUTH_DOMAIN_MISMATCH"
  | "OPS_IDENTITY_REQUIRED"
  | "OPS_APPROVAL_REQUIRED"
  | "OPS_REVIEW_UNAVAILABLE";

export type PluginAuthHttpStatus = 400 | 401 | 403 | 404 | 429;

const pluginAuthHttpStatusByCode: Record<
  PluginAuthErrorCode,
  PluginAuthHttpStatus
> = {
  INVALID_REQUEST: 400,
  PAIRING_UNAVAILABLE: 404,
  POLL_RATE_LIMITED: 429,
  COMPANY_IDENTITY_REJECTED: 400,
  INVALID_DEVICE_CREDENTIAL: 400,
  BINDING_REVOKED: 403,
  PRINCIPAL_DISABLED: 403,
  ROTATION_UNAVAILABLE: 400,
  LEASE_INVALID: 401,
  LEASE_EXPIRED: 401,
  BINDING_MISMATCH: 403,
  AUTH_DOMAIN_MISMATCH: 403,
  OPS_IDENTITY_REQUIRED: 401,
  OPS_APPROVAL_REQUIRED: 400,
  OPS_REVIEW_UNAVAILABLE: 400,
};

export class PluginAuthError extends Error {
  public constructor(
    public readonly code: PluginAuthErrorCode,
    public readonly publicMessage: string,
    public readonly httpStatus?: PluginAuthHttpStatus,
  ) {
    super(publicMessage);
    this.name = "PluginAuthError";
  }
}

export function pluginAuthHttpStatus(error: PluginAuthError): PluginAuthHttpStatus {
  return error.httpStatus ?? pluginAuthHttpStatusByCode[error.code];
}

export function pairingUnavailable(): PluginAuthError {
  return new PluginAuthError(
    "PAIRING_UNAVAILABLE",
    "Pairing request unavailable",
  );
}

export function authDenied(
  code: PluginAuthErrorCode = "INVALID_DEVICE_CREDENTIAL",
): PluginAuthError {
  return new PluginAuthError(code, "Plugin authorization failed");
}
