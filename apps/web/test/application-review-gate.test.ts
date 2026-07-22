import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApplicationReviewGate,
  cancelSubmissionDialog,
  dismissSubmissionDialog,
  sendSubmitCommandOnce,
  SUBMISSION_CONFIRMATION_BODY,
  SUBMISSION_CONFIRMATION_TITLE,
} from "../app/components/application-review-gate";
import { buildApplicationRevisionCommand } from "../app/lib/application-review-gate";
import { clipTextToCodePoints } from "../app/lib/application-text";

describe("buildApplicationRevisionCommand", () => {
  test("trims review guidance into the exact revise command", () => {
    expect(buildApplicationRevisionCommand("  Recheck the employment dates.  ")).toEqual({
      success: true,
      command: {
        type: "revise",
        context: "Recheck the employment dates.",
      },
    });
  });

  test("enforces the one through twenty-thousand code-point boundary", () => {
    expect(buildApplicationRevisionCommand("   ")).toEqual({
      success: false,
      message: "Enter revision instructions between 1 and 20,000 characters.",
    });
    expect(buildApplicationRevisionCommand("𐐀".repeat(20_000))).toMatchObject({
      success: true,
    });
    expect(buildApplicationRevisionCommand("𐐀".repeat(20_001))).toEqual({
      success: false,
      message: "Enter revision instructions between 1 and 20,000 characters.",
    });
  });

  test("clips input by Unicode code points without splitting astral characters", () => {
    expect(clipTextToCodePoints(`a${"𐐀".repeat(2_000)}b`, 2_001))
      .toBe(`a${"𐐀".repeat(2_000)}`);
    expect(clipTextToCodePoints("short", 20_000)).toBe("short");
  });
});

describe("ApplicationReviewGate", () => {
  test("renders the exact irreversible submission confirmation", () => {
    const markup = renderToStaticMarkup(createElement(ApplicationReviewGate, {
      busy: false,
      busyAction: null,
      onCommand: async () => {},
    }));

    expect(SUBMISSION_CONFIRMATION_TITLE).toBe("Submit this application?");
    expect(SUBMISSION_CONFIRMATION_BODY).toBe(
      "This action is irreversible. The application assistant will submit the completed application in the headed browser. Continue only after you have reviewed every field and warning.",
    );
    expect(markup).toContain(`<h2 id="application-submit-dialog-title">${SUBMISSION_CONFIRMATION_TITLE}</h2>`);
    expect(markup).toContain(`<p id="application-submit-dialog-description">${SUBMISSION_CONFIRMATION_BODY}</p>`);
    expect(markup).toContain("Approve and submit");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain('aria-labelledby="application-submit-dialog-title"');
    expect(markup).toContain('aria-describedby="application-submit-dialog-description"');
    expect(markup).not.toContain("Ready for human submit");
  });

  test("sends exactly one submit command when confirmation is repeated", async () => {
    const commands: unknown[] = [];
    const sent = { current: false };
    const onCommand = async (command: unknown) => {
      commands.push(command);
    };

    await Promise.all([
      sendSubmitCommandOnce(sent, onCommand),
      sendSubmitCommandOnce(sent, onCommand),
    ]);

    expect(commands).toEqual([{ type: "submit" }]);
  });

  test("Cancel and Escape send nothing and restore focus to the opener", () => {
    let closeCount = 0;
    let focusCount = 0;
    let preventDefaultCount = 0;
    const dialog = {
      open: true,
      close: () => {
        closeCount += 1;
      },
    };
    const opener = {
      focus: () => {
        focusCount += 1;
      },
    };
    const commands: unknown[] = [];

    dismissSubmissionDialog(dialog, opener);
    cancelSubmissionDialog({
      preventDefault: () => {
        preventDefaultCount += 1;
      },
    }, dialog, opener);

    expect(commands).toEqual([]);
    expect(closeCount).toBe(2);
    expect(focusCount).toBe(2);
    expect(preventDefaultCount).toBe(1);
  });
});
