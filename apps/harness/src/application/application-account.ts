import config from "../../../../config.json";

export const DEFAULT_APPLICATION_EMAIL = config.application.email;
export const DEFAULT_APPLICATION_PASSWORD = config.application.password;

export const DEFAULT_APPLICATION_CREDENTIALS: readonly [string, string] | undefined =
  DEFAULT_APPLICATION_EMAIL && DEFAULT_APPLICATION_PASSWORD
    ? [DEFAULT_APPLICATION_EMAIL, DEFAULT_APPLICATION_PASSWORD]
    : undefined;
