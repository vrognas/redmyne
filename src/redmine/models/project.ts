import { NamedEntity, CustomField } from "./common";

export interface Project {
  id: number;
  name: string;
  description: string;
  identifier: string;
  parent?: NamedEntity;
  custom_fields?: CustomField[];
}
