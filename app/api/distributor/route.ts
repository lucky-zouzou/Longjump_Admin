import {env} from "cloudflare:workers";
import {handleDistributor} from "../../../lib/distributor-http.mjs";
import {database} from "../../../lib/database";
export function GET(request:Request){return handleDistributor(request,database(),env.WHOLESALE_FILES as Parameters<typeof handleDistributor>[2]);}
export const POST=GET;
