import { z } from 'zod'

export const SCIM = {
  User: 'urn:ietf:params:scim:schemas:core:2.0:User', Group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  List: 'urn:ietf:params:scim:api:messages:2.0:ListResponse', Patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  Search: 'urn:ietf:params:scim:api:messages:2.0:SearchRequest', Error: 'urn:ietf:params:scim:api:messages:2.0:Error',
}
export class ScimError extends Error {
  constructor(public status: number, public scimType: string | undefined, message: string) { super(message) }
}
export function scimFailure(error: unknown) {
  const failure = error instanceof ScimError ? error : error instanceof z.ZodError
    ? new ScimError(400,'invalidValue','Check the resource attributes and their types.')
    : new ScimError(500,undefined,'The provisioning request could not be completed.')
  return { status: failure.status, body: { schemas: [SCIM.Error], status: String(failure.status), ...(failure.scimType ? { scimType: failure.scimType } : {}), detail: failure.message } }
}
// SCIM attribute names are case-insensitive, including PATCH operation fields.
export function scimAttributes(value: unknown, depth = 0): any {
  if (depth > 8) throw new ScimError(400,'invalidValue','Resource nesting exceeds the supported depth.')
  if (Array.isArray(value)) return value.map(item => scimAttributes(item,depth+1))
  if (!value || typeof value !== 'object') return value
  const entries = Object.entries(value), keys = entries.map(([key])=>key.toLowerCase())
  if (new Set(keys).size !== keys.length || keys.some(key=>['__proto__','constructor','prototype'].includes(key))) throw new ScimError(400,'invalidValue','Duplicate or invalid attribute names.')
  return Object.fromEntries(entries.map(([key,item])=>[key.toLowerCase(),scimAttributes(item,depth+1)]))
}
const text = z.string().trim().max(160).refine(value=>!/[\u0000-\u001f\u007f]/.test(value))
const external = z.string().min(1).max(256).nullable().optional()
export const scimUserInput = z.object({
  username: z.email().max(254).transform(value=>value.toLowerCase()),
  externalid: external, active: z.boolean().default(true), displayname: text.default(''),
  name: z.object({ givenname: text.optional(), familyname: text.optional(), formatted: text.optional() }).default({}),
  emails: z.array(z.object({ value: z.email().max(254), type: text.optional(), primary: z.boolean().optional() })).max(10).default([]),
}).refine(value=>value.emails.filter(email=>email.primary).length<=1,'Only one primary email is supported.')
export const scimGroupInput = z.object({
  displayname: text.min(1), externalid: external,
  members: z.array(z.object({ value: z.uuid().transform(value=>value.toLowerCase()) })).max(1000).default([]),
})
export function resourceInput(kind: 'Users'|'Groups', body: unknown) {
  const value = scimAttributes(body)
  if (!value || !Array.isArray(value.schemas) || !value.schemas.includes(kind==='Users' ? SCIM.User : SCIM.Group)) throw new ScimError(400,'invalidValue','Include the resource schema.')
  if (['password','roles','entitlements'].some(key=>key in value)) throw new ScimError(400,'mutability','Passwords, administrator roles and licences are not managed through SCIM.')
  return value
}
export function patchResource(kind: 'Users'|'Groups', original: any, body: unknown) {
  const value = z.object({ schemas:z.array(z.string()).refine(value=>value.includes(SCIM.Patch)), operations:z.array(z.object({ op:z.string().transform(value=>value.toLowerCase()).pipe(z.enum(['add','replace','remove'])),path:z.string().max(512).optional(),value:z.unknown().optional() })).min(1).max(100) }).parse(scimAttributes(body))
  let next = structuredClone(original)
  for (const operation of value.operations) {
    const op = operation.op, path = operation.path?.replace(new RegExp(`^${(kind==='Users'?SCIM.User:SCIM.Group)}:`, 'i'),'').toLowerCase()
    if (op!=='remove' && operation.value===undefined) throw new ScimError(400,'invalidValue','Add and replace operations require a value.')
    if (!path) {
      if (op==='remove') throw new ScimError(400,'noTarget','Remove operations require an attribute path.')
      if (!operation.value || typeof operation.value!=='object' || Array.isArray(operation.value)) throw new ScimError(400,'invalidPath','This operation needs an attribute path or object value.')
      for (const [key, item] of Object.entries(operation.value)) next = patchResource(kind,next,{schemas:[SCIM.Patch],Operations:[{op,path:key,value:item}]})
      continue
    }
    if (kind==='Groups' && path.startsWith('members')) {
      const selected = /^members\[value\s+eq\s+"([a-f0-9-]{36})"\]$/.exec(path)
      if (path!=='members' && !selected) throw new ScimError(400,'invalidPath','Use members or members[value eq "id"].')
      if (selected) {
        if (op!=='remove') throw new ScimError(400,'invalidPath','A member filter supports removal only.')
        // Removing an absent group member is intentionally idempotent.
        next.members = next.members.filter((item:any)=>item.value.toLowerCase()!==selected[1])
      } else if (op==='remove') next.members=[]
      else {
        const members=scimGroupInput.shape.members.parse(operation.value)
        next.members = op==='replace' ? members : [...next.members,...members]
        next.members = [...new Map(next.members.map((item:any)=>[item.value,item])).values()]
      }
    } else {
      const allowed = kind==='Users' ? ['username','externalid','active','displayname','name','name.givenname','name.familyname','name.formatted','emails'] : ['displayname','externalid']
      if (!allowed.includes(path)) throw new ScimError(400,'mutability','This attribute is not writable.')
      if (op==='remove' && ['username','active',...(kind==='Groups'?['displayname']:[])].includes(path)) throw new ScimError(400,'mutability','This attribute cannot be removed.')
      if (path.startsWith('name.')) {
        next.name ??= {}
        if (op==='remove') delete next.name[path.slice(5)]; else next.name[path.slice(5)]=operation.value
      } else if (op==='remove') delete next[path]
      else if (path==='name') next.name={...next.name,...scimUserInput.shape.name.parse(operation.value)}
      else if (op==='add' && path==='emails') {
        const added=scimUserInput.shape.emails.parse(operation.value)
        const current=added.some(item=>item.primary) ? (next.emails??[]).map((item:any)=>({...item,primary:false})) : (next.emails??[])
        const key=(item:any)=>JSON.stringify([item.value.toLowerCase(),item.type?.toLowerCase()??''])
        const emails=new Map<string,any>(current.map((item:any)=>[key(item),item]))
        for(const item of added) emails.set(key(item),{...emails.get(key(item)),...item})
        next.emails=[...emails.values()]
      }
      else next[path]=operation.value
    }
  }
  return next
}
export function scimListQuery(input: unknown, kind: 'Users'|'Groups') {
  const value=z.object({ startIndex:z.coerce.number().int().max(1_000_000).default(1),count:z.coerce.number().int().default(100),filter:z.string().max(1024).optional(),attributes:z.string().max(1024).optional(),excludedAttributes:z.string().max(1024).optional() }).strict().parse(input)
  let filter: { column:string; value:string }|undefined
  if (value.filter) {
    const match=/^\s*(userName|displayName|externalId|id)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i.exec(value.filter)
    if (!match) throw new ScimError(400,'invalidFilter','Supported filters use eq with id, externalId, userName or displayName.')
    const attribute=match[1]!.toLowerCase()
    const columns: Record<string,string>={id:'s.id::text',externalid:'s.external_id',...(kind==='Users'?{username:'s.email',displayname:"s.profile->>'displayname'"}:{displayname:'g.name'})}
    if (!columns[attribute]) throw new ScimError(400,'invalidFilter','This resource does not support that filter attribute.')
    let argument:unknown
    try { argument=JSON.parse(match[2]!) } catch { throw new ScimError(400,'invalidFilter','The filter value must be a JSON string.') }
    if (typeof argument!=='string' || argument.length>256) throw new ScimError(400,'invalidFilter','The filter value is too long.')
    filter={column:columns[attribute]!,value:argument}
  }
  if (value.attributes && value.excludedAttributes) throw new ScimError(400,'invalidValue','Use attributes or excludedAttributes, not both.')
  scimProjection({},value.attributes,value.excludedAttributes)
  return {...value,startIndex:Math.max(1,value.startIndex),count:Math.max(0,Math.min(100,value.count)),filter}
}
export function scimProjection(resource:any, attributes?:string, excluded?:string) {
  if (!attributes && !excluded) return resource
  const names=(attributes??excluded!).split(',').map(value=>value.trim().toLowerCase())
  if (names.some(name=>!name || name.includes('.'))) throw new ScimError(400,'invalidValue','Attribute selection supports top-level attributes.')
  return Object.fromEntries(Object.entries(resource).filter(([key])=>['schemas','id'].includes(key) || (attributes ? names.includes(key.toLowerCase()) : !names.includes(key.toLowerCase()))))
}

export function scimSchemas() {
  const attribute=(name:string,type='string',options:Record<string,unknown>={})=>({name,type,multiValued:false,required:false,caseExact:false,mutability:'readWrite',returned:'default',uniqueness:'none',...options})
  const base=[attribute('id','string',{required:true,caseExact:true,mutability:'readOnly',returned:'always',uniqueness:'server'}),attribute('externalId','string',{caseExact:true})]
  return [
    {schemas:['urn:ietf:params:scim:schemas:core:2.0:Schema'],id:SCIM.User,name:'User',description:'Customer-scoped provisioned users; verified sign-in and a separately assigned licence are required for calling.',attributes:[...base,
      attribute('userName','string',{required:true,mutability:'immutable',uniqueness:'server',description:'The verified sign-in email. Contact an administrator to migrate an identity.'}),attribute('active','boolean'),attribute('displayName'),
      attribute('name','complex',{subAttributes:['givenName','familyName','formatted'].map(name=>attribute(name))}),
      attribute('emails','complex',{multiValued:true,subAttributes:[attribute('value'),attribute('type'),attribute('primary','boolean')]})]},
    {schemas:['urn:ietf:params:scim:schemas:core:2.0:Schema'],id:SCIM.Group,name:'Group',description:'Provisioned customer groups. Calling-account assignments are managed in Sipper.',attributes:[...base,attribute('displayName','string',{required:true}),attribute('members','complex',{multiValued:true,subAttributes:[attribute('value','string',{required:true,caseExact:true}),attribute('$ref','reference',{mutability:'readOnly',referenceTypes:['User']})]})]},
  ]
}
