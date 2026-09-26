import { componentOf } from "@/lib/match/component";
import { buildAccessProfile } from "@/lib/match/access";
const texts = [
  "Versaport™ Plus Bladeless 12 mm Standard length with fixation cannula",
  "Single use fixation cannula with 5 mm - 12 mm Versaseal™ Plus seal for use with Versaport™ Plus Bladeless trocar",
  "11mm ST Fixation Sleeve Assembly for Versaport™ Bladeless",
  "Versaport™ Plus 12 mm Fixation Cannula",
  "Versaport™ Plus 5 mm - 11 mm Sleeve",
  "ENDOPATH XCEL Bladeless Trocars with Stability Sleeves",
  "ENDOPATH XCEL Universal Sleeves 12 mm, 100 mm length",
  "VersaOne™ Universal Fixation Cannula; Size: 12 mm; Length: 100 mm",
  "Kii Fios First Entry — Trocar",
  "Kii Sleeve 12 mm Advanced Fixation Cannula",
  "Thoracoport™ 10.5 mm for instrument up to 11 mm; Single Use Trocar; Non-conductive Sleeve",
];
for (const t of texts) { const p = buildAccessProfile([{ text: t, source: "gudid:description" }]); console.log(componentOf(t).padEnd(16), p.component.padEnd(10), p.evidence.find((e) => e.field === "component")?.via ?? "-", "|", t); }
