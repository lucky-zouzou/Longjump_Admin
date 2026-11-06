import {handleDistributor} from "../../lib/distributor-http.mjs";
import {database} from "../../lib/database";
export function GET(request:Request){return handleDistributor(request,database());}
