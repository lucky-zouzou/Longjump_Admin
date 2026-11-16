import {readWorkplaceWeather} from '../../../lib/workplace-weather.mjs';

export async function GET(request:Request) {
  const {body,status}=await readWorkplaceWeather(new URL(request.url).searchParams);
  return Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
}
