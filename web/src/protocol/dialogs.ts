import type { AskQuestion, DialogRequest, QueueImage } from "./types";

export const OTHER_OPTION = "Other (type your own)";
export const OTHER_OPTION_LOWER = OTHER_OPTION.toLowerCase();

export interface ApprovalView {
  tool: string;
  command: string | null;
  heading: string;
}

/** Parse `Allow tool: <name>\nCommand: <cmd>` (or `title` only). */
export function parseApproval(dialog: DialogRequest): ApprovalView | null {
  const title = dialog.title ?? "";
  const match = /^\s*Allow tool:\s*([^\n]+?)\s*(?:\n|$)/i.exec(title);
  if (!match) return null;
  const tool = match[1].trim();
  if (!tool) return null;
  const commandMatch = /(?:^|\n)\s*Command:\s*([\s\S]*)$/i.exec(title);
  const command = commandMatch ? commandMatch[1].trim() : null;
  return { tool, command: command || null, heading: `Allow ${tool}?` };
}

export function isApprovalOptions(options: string[] | undefined): boolean {
  if (!options || options.length === 0) return false;
  return options.some((option) => /^(approve|deny|allow)\b/i.test(option.trim()));
}

/** The safe default is the first non-deny option; Deny is never focused first. */
export function safeOptionIndex(options: string[]): number {
  const index = options.findIndex((option) => !/^(deny|no)\b/i.test(option.trim()));
  return index >= 0 ? index : 0;
}

export function optionHint(index: number): string {
  return String(index + 1);
}

/** Field-by-field `ask` fallback: the literal Other row becomes a real text field. */
export function fieldOptions(dialog: DialogRequest): { options: string[]; freeText: boolean } {
  const options = dialog.options ?? [];
  const freeText = options.some((option) => option.trim().toLowerCase() === OTHER_OPTION_LOWER);
  return {
    options: options.filter((option) => option.trim().toLowerCase() !== OTHER_OPTION_LOWER),
    freeText,
  };
}

export function isFieldAsk(dialog: DialogRequest): boolean {
  const options = dialog.options ?? [];
  return options.some((option) => option.trim().toLowerCase() === OTHER_OPTION_LOWER);
}

export function firstQuestion(dialog: DialogRequest): AskQuestion | undefined {
  return dialog.questions?.[0];
}

export interface AskSelection {
  selectedOptions: string[];
  customInput: string;
}

export function emptySelections(questions: AskQuestion[]): Record<string, AskSelection> {
  const map: Record<string, AskSelection> = {};
  for (const question of questions) map[question.id] = { selectedOptions: [], customInput: "" };
  return map;
}

export function toggleSelection(
  questions: AskQuestion[],
  selections: Record<string, AskSelection>,
  questionId: string,
  label: string,
): Record<string, AskSelection> {
  const question = questions.find((entry) => entry.id === questionId);
  if (!question) return selections;
  const current = selections[questionId] ?? { selectedOptions: [], customInput: "" };
  if (question.multi) {
    const has = current.selectedOptions.includes(label);
    return {
      ...selections,
      [questionId]: {
        selectedOptions: has
          ? current.selectedOptions.filter((entry) => entry !== label)
          : [...current.selectedOptions, label],
        customInput: current.customInput,
      },
    };
  }
  // Single select clears free text; typing free text clears the selection.
  return { ...selections, [questionId]: { selectedOptions: [label], customInput: "" } };
}

export function setCustomInput(
  questions: AskQuestion[],
  selections: Record<string, AskSelection>,
  questionId: string,
  value: string,
): Record<string, AskSelection> {
  const question = questions.find((entry) => entry.id === questionId);
  if (!question) return selections;
  const current = selections[questionId] ?? { selectedOptions: [], customInput: "" };
  return {
    ...selections,
    [questionId]: { selectedOptions: question.multi ? current.selectedOptions : [], customInput: value },
  };
}

export function buildAskAnswers(
  questions: AskQuestion[],
  selections: Record<string, AskSelection>,
): { id: string; selectedOptions?: string[]; customInput?: string }[] {
  return questions.map((question) => {
    const selection = selections[question.id] ?? { selectedOptions: [], customInput: "" };
    const answer: { id: string; selectedOptions?: string[]; customInput?: string } = { id: question.id };
    if (selection.selectedOptions.length > 0) answer.selectedOptions = selection.selectedOptions;
    if (selection.customInput.trim()) answer.customInput = selection.customInput.trim();
    return answer;
  });
}

export function approvalAnswer(index: number, options: string[]): { value: string } {
  return { value: options[index] ?? options[0] ?? "" };
}

export function queueImagesFromPayload(value: unknown): QueueImage[] {
  if (!Array.isArray(value)) return [];
  const images: QueueImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; mimeType?: unknown; data?: unknown };
    if (record.type !== "image" || typeof record.mimeType !== "string" || typeof record.data !== "string") continue;
    images.push({ mimeType: record.mimeType, data: record.data });
  }
  return images;
}
