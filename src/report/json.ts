import type { ScanReport } from "../commands/scan.ts";

export const renderJson = (r: ScanReport): string => `${JSON.stringify(r, null, 2)}\n`;
