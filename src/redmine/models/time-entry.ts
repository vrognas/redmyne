import { TimeEntryActivity } from "./time-entry-activity";
import { NamedEntity } from "./named-entity";

export interface TimeEntry {
  id?: number; // Present in GET responses
  issue_id: number;
  issue?: { id: number; subject: string }; // Present in GET responses
  activity_id: TimeEntryActivity["id"];
  activity?: NamedEntity; // Present in GET responses
  hours: string;
  comments: string;
  spent_on?: string; // Date in YYYY-MM-DD format, present in GET responses
  user?: NamedEntity; // Present in GET responses
  created_on?: string; // ISO date string, present in GET responses
  updated_on?: string; // ISO date string, present in GET responses
}
