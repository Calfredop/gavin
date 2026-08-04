export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  labelIds: string[];
  priority: Priority;
  position: number;
}

export interface Column {
  id: string;
  name: string;
  position: number;
  cards: Card[];
}

export interface Board {
  columns: Column[];
  labels: Label[];
}
