/** Compatibility exports: all API routes share one client-identity policy and bounded body reader. */
export { clientIp, readBody, readFormData, readJson, readJsonValue, readText, readTextLimited, type BodyRead } from "@/lib/http";
