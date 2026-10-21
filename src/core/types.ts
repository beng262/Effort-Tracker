import { z } from 'zod';

/** One row as the model proposes it. Everything here is untrusted until normalise() has checked it. */
export const proposedRowSchema = z.object({
  date: z.string().nullable().describe('Date or weekday exactly as written, e.g. "pzt", "12.10", "6 Ekim"'),
  time: z.string().nullable().describe('Clock range as written, e.g. "09:00-12:30", or a phrase like "öğleden sonra"'),
  effort: z.string().nullable().describe('Effort exactly as written, e.g. "3s", "2,5 saat", "yarım gün"'),
  description: z.string(),
  task_hint: z.string().nullable().describe('Planner task title or id mentioned in the text'),
  ticket_hint: z.string().nullable().describe('ITSM ticket id mentioned, e.g. INC-20871'),
  project_hint: z.string().nullable(),
  leave: z.boolean().describe('True when the line only says the person was on leave'),
  confidence: z.number().describe('0 to 1'),
  source: z.string().describe('Cell address ("Sheet1!B4") or line number ("L3") the row came from'),
  source_text: z.string().describe('The exact text of that cell or line, copied verbatim'),
});
export type ProposedRow = z.infer<typeof proposedRowSchema>;

export const columnMappingSchema = z.object({
  sheet: z.string(),
  header_row: z.number().int().describe('1-based row number of the header'),
  date: z.string().nullable().describe('Column letter holding the date or weekday'),
  start: z.string().nullable(),
  end: z.string().nullable(),
  effort: z.string().nullable().describe('Column letter holding hours or a duration'),
  description: z.string().nullable(),
  task: z.string().nullable(),
  ticket: z.string().nullable(),
  project: z.string().nullable(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const extractionSchema = z.object({
  rows: z.array(proposedRowSchema),
  mappings: z.array(columnMappingSchema).describe('One per Excel sheet that holds effort; empty for free text'),
  notes: z.array(z.string()).describe('Things you could not interpret'),
});
export type Extraction = z.infer<typeof extractionSchema>;

export type Flag =
  | 'future_date'
  | 'over_10h_day'
  | 'weekend'
  | 'duplicate'
  | 'closed_period'
  | 'no_date'
  | 'no_effort'
  | 'number_not_in_source'
  | 'low_confidence'
  | 'zero_effort'
  | 'not_quarter_hour'
  | 'name_mismatch'
  | 'unknown_category'
  | 'no_customer';

/** What the standard form carries beyond the effort itself. */
export interface RowExtras {
  category?: string | null;
  customer?: string | null;
  work_item?: string | null;
  product?: string | null;
  outcome?: string | null;
  progress?: string | null;
}

export interface NormalisedRow {
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  hours: number | null;
  /** How `hours` was produced, so the review screen can explain it. */
  hoursRule: string | null;
  description: string;
  taskHint: string | null;
  ticketHint: string | null;
  projectHint: string | null;
  confidence: number;
  source: string;
  sourceText: string;
  flags: Flag[];
  extras?: RowExtras;
  /** The name the file said the work was done by (the standard form's "Çalışan" column). */
  employee?: string | null;
}

export interface Candidate {
  kind: 'planner' | 'itsm' | 'project';
  id: string;
  title: string;
  /** A short id people type, such as W1.4 for a project plan task. */
  code?: string;
  /** Extra searchable text: customer, bucket, plan name. */
  extra?: string;
}

export interface LinkResult {
  kind: 'planner' | 'itsm' | 'project' | null;
  id: string | null;
  score: number;
  via: 'explicit-id' | 'exact-title' | 'fuzzy' | 'model' | 'none';
  /** Candidates worth showing when nothing was picked automatically. */
  options: Candidate[];
}
