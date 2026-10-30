import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";

import { Emitter } from "./events.ts";

export const ASK_USER_TOOL = "ask_user";

const QuestionSchema = Type.Object({
  header: Type.String({ description: "A label of at most a few words, e.g. “Account”." }),
  question: Type.String({ description: "The full question, ending with a question mark." }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "The choice, in a few words." }),
      description: Type.Optional(Type.String({ description: "What picking it means." })),
    }),
    {
      maxItems: 4,
      description:
        "2–4 choices, or none when the answer is something the user types, such as a number, name or date.",
    },
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Whether the user may pick more than one option." }),
  ),
});

const AskUserParameters = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

const AnswerSchema = Type.Object({
  question: Type.String(),
  /** The options picked and anything the user wrote instead; empty when they skipped it. */
  answers: Type.Array(Type.String()),
});

export type Question = Static<typeof QuestionSchema>;
export type Answer = Static<typeof AnswerSchema>;

/** What the transcript keeps of an answered `ask_user` call. */
export type AskUserDetails = {
  answers: Answer[];
  /** The user dismissed the questions without answering. */
  dismissed?: true;
};

/** Questions the agent is waiting on the user to answer. */
export interface PendingQuestions {
  conversationId: ConversationId;
  callId: string;
  questions: Question[];
  /** Answer, one entry per question, in order. */
  answer(answers: Answer[]): void;
  /** Let the agent carry on without answers. */
  dismiss(): void;
}

/** Hands the agent's questions to the UI and the user's answers back to the agent. */
export class Questions {
  readonly onChange = new Emitter();
  #pending: PendingQuestions[] = [];

  /** Questions still waiting for an answer, oldest first. */
  pending(conversationId: ConversationId): PendingQuestions | undefined {
    return this.#pending.find((pending) => pending.conversationId === conversationId);
  }

  /** Wait for the user to answer `questions`; rejects when `signal` aborts. */
  ask(
    conversationId: ConversationId,
    callId: string,
    questions: Question[],
    signal: AbortSignal,
  ): Promise<{ answers: Answer[]; dismissed: boolean }> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal.removeEventListener("abort", abort);
        this.#pending = this.#pending.filter((other) => other !== pending);
        this.onChange.emit();
      };
      const abort = () => {
        settle();
        reject(signal.reason);
      };
      const pending: PendingQuestions = {
        conversationId,
        callId,
        questions,
        answer: (answers) => {
          if (!this.#pending.includes(pending)) return;
          settle();
          resolve({ answers, dismissed: false });
        },
        dismiss: () => {
          if (!this.#pending.includes(pending)) return;
          settle();
          resolve({
            answers: questions.map(({ question }) => ({ question, answers: [] })),
            dismissed: true,
          });
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending = [...this.#pending, pending];
      this.onChange.emit();
    });
  }
}

/** The answers as the model reads them. */
export function describeAnswers({ answers, dismissed }: AskUserDetails): string {
  if (dismissed) {
    return "The user dismissed the questions without answering. Carry on with your best judgement, or ask in your reply.";
  }
  const lines = answers.map(
    ({ question, answers }) =>
      `- ${question}\n  ${answers.length > 0 ? answers.join("; ") : "(no answer)"}`,
  );
  return `The user answered:\n${lines.join("\n")}`;
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * Ask the user and wait for the answer. Replay-safe, so a question the panel closed on is asked
 * again when it reopens.
 */
export function askUserTool(questions: Questions): ToolRegistration {
  return defineTool({
    name: ASK_USER_TOOL,
    description: `Ask the user 1–4 multiple-choice questions and wait for the answers. Use it when you need a decision only the user can make, are unsure what they want, or need their go-ahead before something hard to undo; do not use it when a sensible default exists. Give a question 2–4 options when it has a few likely answers, and none when the user must type the answer (a number, a name, a date): options that only stand in for typing it, such as "Enter my GPA", cannot answer it. The user can always write their own answer instead of picking.`,
    parameters: AskUserParameters,
    structuredOutputSchema: Type.Array(AnswerSchema),
    replay: "safe",
    async execute(args, api, context) {
      const result = await questions.ask(
        api.conversationId,
        api.callId,
        args.questions,
        context.abortSignal ?? NEVER_ABORTED,
      );
      const details: AskUserDetails = result.dismissed
        ? { answers: result.answers, dismissed: true }
        : { answers: result.answers };
      return {
        output: [{ type: "text", text: describeAnswers(details) }],
        structuredOutput: result.answers,
        details,
      };
    },
  }) as ToolRegistration;
}
