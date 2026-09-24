import type { OpportunityKind } from "../contracts/models.ts";

export type EvidenceCategory = "profile" | "context" | "anecdote";

export interface AttributedSource {
  readonly name: string;
  readonly category: EvidenceCategory;
  readonly text: string;
}

export interface CandidateContext {
  readonly directFields: Readonly<Record<string, string>>;
  readonly resumeText: string;
  readonly profileNarrative: AttributedSource;
  readonly contextSources: readonly AttributedSource[];
  readonly anecdotes: readonly AttributedSource[];
}

export interface SavedUserInfoFact {
  readonly answer_type: string;
  readonly status: string;
  readonly value?: string | boolean | readonly string[] | null;
}

export interface ApplicationRunRequest {
  readonly session: {
    readonly jobUrl: string;
    readonly opportunityKind: OpportunityKind;
    readonly artifacts: {
      readonly resume: string;
      readonly transcript?: string | null;
    };
  };
  readonly candidate: CandidateContext;
  readonly resumeDisplayName: string;
  readonly resumeSourceDisplayName: string;
  readonly userInfo: {
    readonly savedGlobal: Readonly<Record<string, SavedUserInfoFact>>;
    readonly savedApplication: Readonly<Record<string, SavedUserInfoFact>>;
  };
  readonly resumeUploadPath?: string;
  readonly transcriptDisplayName?: string;
  readonly transcriptUploadPath?: string;
}

export function buildApplicationTask(request: ApplicationRunRequest): string {
  const navigationUrl = new URL(request.session.jobUrl);
  navigationUrl.hash = "";
  const job: Record<string, unknown> = {
    url: navigationUrl.href,
    opportunity_kind: request.session.opportunityKind,
    resume: {
      display_name: request.resumeDisplayName,
      path: request.resumeUploadPath ?? request.session.artifacts.resume,
    },
  };
  if (request.transcriptDisplayName !== undefined) {
    const transcriptPath = request.transcriptUploadPath ?? request.session.artifacts.transcript;
    if (transcriptPath === undefined || transcriptPath === null) {
      throw new TypeError("transcript path is required when transcript is available");
    }
    job.transcript = {
      display_name: request.transcriptDisplayName,
      path: transcriptPath,
    };
  }

  const evidence: Array<Record<string, string>> = [{
    category: "resume",
    name: request.resumeSourceDisplayName,
    text: request.candidate.resumeText,
  }];
  if (request.candidate.profileNarrative.text !== "") {
    evidence.push({
      category: request.candidate.profileNarrative.category,
      name: request.candidate.profileNarrative.name,
      text: request.candidate.profileNarrative.text,
    });
  }
  for (const source of [...request.candidate.contextSources, ...request.candidate.anecdotes]) {
    evidence.push({ category: source.category, name: source.name, text: source.text });
  }

  return JSON.stringify({
    job,
    user_info: {
      explicit: request.candidate.directFields,
      saved_global: request.userInfo.savedGlobal,
      saved_application: request.userInfo.savedApplication,
    },
    evidence,
  });
}
