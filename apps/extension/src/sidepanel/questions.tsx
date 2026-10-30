import { CheckIcon, ChevronLeftIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { Answer, AskUserDetails, PendingQuestions, Question } from "../core/questions.ts";

interface Draft {
  callId: string;
  index: number;
  /** The options picked, per question. */
  picked: string[][];
  /** What the user wrote instead, per question. */
  written: string[];
}

function emptyDraft({ callId, questions }: PendingQuestions): Draft {
  return {
    callId,
    index: 0,
    picked: questions.map(() => []),
    written: questions.map(() => ""),
  };
}

/** One question's answer: what the user wrote replaces a single choice, and adds to several. */
function answerOf(question: Question, picked: readonly string[], written: string): string[] {
  const text = written.trim();
  if (!text) return [...picked];
  return question.multiSelect ? [...picked, text] : [text];
}

/**
 * Answering the agent's questions one at a time in the message box: options are picked from the
 * panel above it, and what the user types there is their own answer to the current question.
 */
export interface QuestionFlow {
  pending: PendingQuestions;
  question: Question;
  index: number;
  total: number;
  isLast: boolean;
  isPicked(label: string): boolean;
  pick(label: string): void;
  written: string;
  write(text: string): void;
  /** Whether the current question has an answer to move on with. */
  canContinue: boolean;
  /** Move to the next question, or send the answers after the last one. */
  next: () => void;
  back: () => void;
  dismiss: () => void;
}

export function useQuestionFlow(pending: PendingQuestions | undefined): QuestionFlow | undefined {
  const [stored, setDraft] = useState<Draft>();
  if (!pending) return undefined;
  // New questions start over.
  const draft = stored?.callId === pending.callId ? stored : emptyDraft(pending);
  const { questions } = pending;
  const { index } = draft;
  const question = questions[index]!;
  const isLast = index === questions.length - 1;
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const at = <T,>(list: readonly T[], value: T) =>
    list.map((item, i) => (i === index ? value : item));
  const current = answerOf(question, draft.picked[index]!, draft.written[index]!);

  /** Apply `patch`, then go on to the next question or send the answers. */
  const advance = (patch: Partial<Draft> = {}) => {
    const next = { ...draft, ...patch };
    if (!isLast) return setDraft({ ...next, index: index + 1 });
    const answers: Answer[] = questions.map((each, i) => ({
      question: each.question,
      answers: answerOf(each, next.picked[i]!, next.written[i]!),
    }));
    pending.answer(answers);
  };

  return {
    pending,
    question,
    index,
    total: questions.length,
    isLast,
    isPicked: (label) => draft.picked[index]!.includes(label),
    pick: (label) => {
      if (question.multiSelect) {
        const picked = draft.picked[index]!;
        const next = picked.includes(label)
          ? picked.filter((other) => other !== label)
          : [...picked, label];
        return update({ picked: at(draft.picked, next) });
      }
      // A single choice answers the question; what was typed for it is dropped.
      advance({ picked: at(draft.picked, [label]), written: at(draft.written, "") });
    },
    written: draft.written[index]!,
    write: (text) => update({ written: at(draft.written, text) }),
    canContinue: current.length > 0,
    next: () => {
      if (current.length > 0) advance();
    },
    back: () => update({ index: Math.max(0, index - 1) }),
    dismiss: () => pending.dismiss(),
  };
}

/** The current question and its options, shown in the message box above the text field. */
export function QuestionPanel({ flow }: { flow: QuestionFlow }) {
  const { question, index, total } = flow;
  return (
    <InputGroupAddon
      align="block-start"
      className="flex-col items-stretch gap-2 border-b px-3 pt-2.5 pb-2.5 text-foreground"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5" />
        <span className="min-w-0 truncate font-medium tracking-wide uppercase">
          {question.header}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {total > 1 ? (
            <>
              <InputGroupButton
                variant="ghost"
                size="icon-xs"
                aria-label="Previous question"
                disabled={index === 0}
                onClick={flow.back}
              >
                <ChevronLeftIcon />
              </InputGroupButton>
              <span className="px-1 tabular-nums">
                {index + 1}/{total}
              </span>
            </>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupButton
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss questions"
                  onClick={flow.dismiss}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipContent>Skip — let the agent decide</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <p className="text-sm font-medium text-pretty">{question.question}</p>
      {question.options.length > 0 ? (
        <div
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-label={question.question}
          className="flex flex-col gap-1"
        >
          {question.options.map((option) => {
            const picked = flow.isPicked(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={picked}
                onClick={() => flow.pick(option.label)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:hover:bg-muted/50",
                  picked && "border-primary/60 bg-muted dark:bg-muted/50",
                )}
              >
                <span
                  className={cn(
                    "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border",
                    picked && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {picked ? <CheckIcon className="size-3" /> : null}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm">{option.label}</span>
                  {option.description ? (
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {question.multiSelect && question.options.length > 0 ? (
        <p className="text-xs text-muted-foreground">Pick any that apply.</p>
      ) : null}
    </InputGroupAddon>
  );
}

/** An `ask_user` call in the transcript: each question with the answer the user gave. */
export function AskUserCall({ args, details }: { args: unknown; details: unknown }) {
  const { questions = [] } = (args ?? {}) as { questions?: Question[] };
  const answered = details as AskUserDetails | undefined;
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {questions.map((question, i) => {
        const answers = answered?.answers[i]?.answers ?? [];
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{question.question}</dt>
            <dd>
              {answered?.dismissed
                ? "Skipped"
                : answers.length > 0
                  ? answers.join(", ")
                  : answered
                    ? "No answer"
                    : "Waiting for your answer…"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
