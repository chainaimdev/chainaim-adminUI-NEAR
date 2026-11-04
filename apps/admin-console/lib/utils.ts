import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class-name join used by shadcn components (components.json "utils" alias). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
