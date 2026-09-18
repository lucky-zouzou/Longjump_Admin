// Raw persistence columns never cross the API boundary. Parsed, permission-scoped
// fields are assembled by the domain code before this final serialization pass.
export function publicSystemSnapshot(value){
  if(Array.isArray(value))return value.map(publicSystemSnapshot);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!key.endsWith('_json')).map(([key,item])=>[key,publicSystemSnapshot(item)]));
}
