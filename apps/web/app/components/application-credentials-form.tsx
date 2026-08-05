"use client";

import {
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ApplicationSessionCommandSchema,
  type ApplicationSessionCommand,
} from "@jobhunter/pipeline/contracts";
import styles from "../run-detail.module.css";

export type ApplicationCredentialCommandType = Extract<
  ApplicationSessionCommand["type"],
  "sign_in" | "save_credentials"
>;

type ApplicationCredentialCommand = Extract<
  ApplicationSessionCommand,
  { readonly type: ApplicationCredentialCommandType }
>;

type CredentialField = "username" | "password";

export type ApplicationCredentialCommandResult =
  | {
      readonly success: true;
      readonly command: ApplicationCredentialCommand;
    }
  | {
      readonly success: false;
      readonly field: CredentialField;
      readonly message: string;
    };

interface ApplicationCredentialsFormProps {
  readonly busy: boolean;
  readonly busyAction: ApplicationSessionCommand["type"] | null;
  readonly steeringDisabled: boolean;
  readonly onSteerAndContinue: (
    command: ApplicationSessionCommand,
  ) => Promise<void>;
  readonly onSubmit: (command: ApplicationSessionCommand) => Promise<void>;
}

export function buildApplicationCredentialCommand(
  type: ApplicationCredentialCommandType,
  username: string,
  password: string,
): ApplicationCredentialCommandResult {
  const parsed = ApplicationSessionCommandSchema.safeParse({
    type,
    username,
    password,
  });
  if (
    parsed.success
    && (parsed.data.type === "sign_in" || parsed.data.type === "save_credentials")
  ) {
    return { success: true, command: parsed.data };
  }

  const usernameAccepted = ApplicationSessionCommandSchema.safeParse({
    type,
    username,
    password: "validation-probe",
  }).success;
  return usernameAccepted
    ? {
        success: false,
        field: "password",
        message: "Enter a password between 1 and 4,096 characters.",
      }
    : {
        success: false,
        field: "username",
        message: "Enter a username or email between 1 and 320 characters.",
      };
}

export function ApplicationCredentialsForm({
  busy,
  busyAction,
  steeringDisabled,
  onSteerAndContinue,
  onSubmit,
}: ApplicationCredentialsFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<
    Exclude<ApplicationCredentialCommandResult, { readonly success: true }> | null
  >(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submissionPendingRef = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submissionPendingRef.current) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const action = submitter?.getAttribute("value");
    const type: ApplicationCredentialCommandType =
      action === "save_credentials" || action === "steer_save_credentials"
        ? "save_credentials"
        : "sign_in";
    const steerAndContinue =
      action === "steer_sign_in" || action === "steer_save_credentials";
    const result = buildApplicationCredentialCommand(type, username, password);
    if (!result.success) {
      setValidationError(result);
      window.requestAnimationFrame(() => {
        if (result.field === "password") passwordRef.current?.focus();
        else usernameRef.current?.focus();
      });
      return;
    }

    setValidationError(null);
    submissionPendingRef.current = true;
    try {
      await (steerAndContinue
        ? onSteerAndContinue(result.command)
        : onSubmit(result.command));
    } finally {
      submissionPendingRef.current = false;
    }
  };

  const descriptionId = "application-credentials-description";
  const saveDescriptionId = "application-save-credentials-description";
  const errorId = "application-credentials-error";
  const usernameInvalid = validationError?.field === "username";
  const passwordInvalid = validationError?.field === "password";
  const describedBy = (field: CredentialField): string => {
    return validationError?.field === field
      ? `${descriptionId} ${errorId}`
      : descriptionId;
  };

  return (
    <form
      aria-labelledby="application-credentials-heading"
      autoComplete="off"
      className={styles.applicationCredentialsForm}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className={styles.applicationCredentialsIntro}>
        <h3 id="application-credentials-heading">Credentials needed</h3>
        <p id={descriptionId}>
          Enter the username or email and password for this application site.
          Signing in uses them for this browser attempt without saving them.
        </p>
      </div>
      <div className={styles.applicationCredentialFields}>
        <label className={styles.workspaceField} htmlFor="application-credentials-username">
          <span>Username or email</span>
          <input
            ref={usernameRef}
            aria-describedby={describedBy("username")}
            aria-invalid={usernameInvalid || undefined}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={busy}
            id="application-credentials-username"
            name="username"
            onChange={(event) => {
              setUsername(event.currentTarget.value);
              setValidationError(null);
            }}
            required
            spellCheck={false}
            type="text"
            value={username}
          />
        </label>
        <label className={styles.workspaceField} htmlFor="application-credentials-password">
          <span>Password</span>
          <input
            ref={passwordRef}
            aria-describedby={describedBy("password")}
            aria-invalid={passwordInvalid || undefined}
            autoComplete="new-password"
            disabled={busy}
            id="application-credentials-password"
            name="password"
            onChange={(event) => {
              setPassword(event.currentTarget.value);
              setValidationError(null);
            }}
            required
            type="password"
            value={password}
          />
        </label>
      </div>
      {validationError ? (
        <p className={styles.panelError} id={errorId} role="alert">
          {validationError.message}
        </p>
      ) : null}
      <p className={styles.applicationCredentialSaveDescription} id={saveDescriptionId}>
        Save credentials writes them to the private local credential file for
        future sign-ins after creating an account in headed Chrome. It does not
        fill or submit the browser form.
      </p>
      <div className={styles.applicationCredentialActions}>
        <button
          className={styles.primaryButton}
          disabled={busy}
          name="credential_action"
          type="submit"
          value="sign_in"
        >
          {busyAction === "sign_in" ? "Signing in…" : "Sign in with credentials"}
        </button>
        <button
          className={styles.secondaryButton}
          disabled={busy || steeringDisabled}
          name="credential_action"
          type="submit"
          value="steer_sign_in"
        >
          Steer and sign in
        </button>
        <button
          aria-describedby={saveDescriptionId}
          className={styles.secondaryButton}
          disabled={busy}
          name="credential_action"
          type="submit"
          value="save_credentials"
        >
          {busyAction === "save_credentials" ? "Saving credentials…" : "Save credentials"}
        </button>
        <button
          aria-describedby={saveDescriptionId}
          className={styles.secondaryButton}
          disabled={busy || steeringDisabled}
          name="credential_action"
          type="submit"
          value="steer_save_credentials"
        >
          Steer and save credentials
        </button>
      </div>
    </form>
  );
}
