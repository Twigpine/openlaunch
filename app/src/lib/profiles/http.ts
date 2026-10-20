/**
 * Compatibility shim: the request helpers now live in `@/lib/http` so launchpad/API routes do not import a profile
 * module. Existing profile imports keep working.
 */
export { clientIp, readFormData, readJson, readJsonValue, readText, readTextLimited } from "@/lib/http";
