import type { DiscoveryRole } from "./types.ts";

const MACHINE_LEARNING = /\b(?:machine learning|deep learning|artificial intelligence|ai|ml|nlp|computer vision|generative ai)\b/i;
const SECURITY = /\b(?:cyber ?security|information security|application security|security engineer|security analyst|threat|incident response|penetration test)\b/i;
const DATA = /\b(?:data (?:science|scientist|engineering|engineer|analytics|analyst)|business intelligence|bi analyst|quantitative|analytics engineer)\b/i;
const PRODUCT = /\b(?:product management|product manager|product design|product designer|program manager|technical product)\b/i;
const HARDWARE = /\b(?:hardware|electrical|embedded|firmware|fpga|asic|silicon|chip|semiconductor|robotics|mechatronics)\b/i;
const SOFTWARE = /\b(?:software|developer|development|swe|web|frontend|front-end|backend|back-end|full[ -]?stack|mobile|ios|android|devops|site reliability|sre|cloud|platform engineer)\b/i;

export function classifyDiscoveryRole(title: string): DiscoveryRole {
  if (MACHINE_LEARNING.test(title)) return "machine_learning";
  if (SECURITY.test(title)) return "security";
  if (DATA.test(title)) return "data";
  if (PRODUCT.test(title)) return "product";
  if (HARDWARE.test(title)) return "hardware";
  if (SOFTWARE.test(title)) return "software_engineering";
  return "other";
}
