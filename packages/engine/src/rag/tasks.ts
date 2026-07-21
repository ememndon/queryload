import type { TaskDefinition } from '@queryload/shared';

/**
 * The task library (D64) — saved professional prompts. Timeline extraction
 * (D67), contradiction finding (D68), and template drafting (D69) are
 * implemented here as task flows that shape retrieval + the instruction, and
 * ask for cited, structured output.
 */
interface Task extends TaskDefinition {
  readonly instruction: string;
  /** How many chunks to retrieve for this task (broader for whole-set tasks). */
  readonly k: number;
}

const TASKS: readonly Task[] = [
  {
    id: 'summary',
    name: 'Summarize document set',
    description: 'A concise synthesis of the key points across the retrieved documents.',
    kind: 'summary',
    k: 12,
    instruction:
      'Summarize the key points across the excerpts as a short briefing. Group related points, and cite each with [n].',
  },
  {
    id: 'obligations',
    name: 'Extract obligations',
    description: 'Every obligation, deadline, and commitment, each with its source.',
    kind: 'obligations',
    k: 14,
    instruction:
      'Extract every obligation, deadline, payment, and commitment found in the excerpts. Output a numbered list; end each item with its [n] citation. If none are present, say so.',
  },
  {
    id: 'timeline',
    name: 'Build a timeline',
    description: 'A chronological table of events drawn from the documents.',
    kind: 'timeline',
    k: 16,
    instruction:
      'Build a chronological timeline of events from the excerpts. Output a table with columns: Date | Event | Source. Put the [n] citation in the Source column for every row. Only include events supported by the excerpts.',
  },
  {
    id: 'contradictions',
    name: 'Find contradictions',
    description: 'Where the documents disagree, with both sides quoted and cited.',
    kind: 'contradictions',
    k: 16,
    instruction:
      'Identify places where the excerpts disagree or contradict each other. For each contradiction, state the conflict, then quote both sides with their [n] citations. If you find none, say so plainly.',
  },
  {
    id: 'template',
    name: 'Draft from template',
    description: 'Draft a document in the house style of a retrieved template/precedent.',
    kind: 'template',
    k: 12,
    instruction:
      'Treat the retrieved template/precedent excerpts as a style and structure guide. Draft the requested document in that house style. Cite the template excerpts [n] you imitated. Do not invent facts not present in the excerpts.',
  },
];

export function listTasks(): TaskDefinition[] {
  return TASKS.map(({ id, name, description, kind }) => ({ id, name, description, kind }));
}

export function findTask(id: string): Task | undefined {
  return TASKS.find((t) => t.id === id);
}
