import { database } from "../../../lib/database";
import { handleDistributorApplication } from "../../../lib/distributor-application.mjs";

export function GET(request: Request) {
  return handleDistributorApplication(request, database());
}
export const POST = GET;
