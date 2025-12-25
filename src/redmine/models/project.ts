import { NamedEntity } from "./common";

export interface Project {
  id: number;
  name: string;
  description: string;
  identifier: string;
  parent?: NamedEntity;
}
