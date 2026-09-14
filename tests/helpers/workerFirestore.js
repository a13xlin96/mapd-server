// Dedicated worker-query fake. The shared fake intentionally supports only a
// single order field; this one applies multi-field ordering BEFORE its limit
// and compares snapshot cursor values even after the cursor row changes.
const {FakeFirestore}=require('./fakeFirestore');
const value=v=>typeof v?.toMillis==='function'?v.toMillis():v;
const compare=(a,b)=>value(a)<value(b)?-1:value(a)>value(b)?1:0;

class WorkerQuery {
  constructor(db,name,options={}) {
    this.db=db;this.name=name;
    this.options={filters:[],orders:[],limit:null,cursor:null,...options};
  }
  clone(options) {return new WorkerQuery(this.db,this.name,{...this.options,...options});}
  doc(id) {return FakeFirestore.prototype.collection.call(this.db,this.name).doc(id);}
  where(field,op,target) {return this.clone({filters:[...this.options.filters,{field,op,target}]});}
  orderBy(field,direction='asc') {return this.clone({orders:[...this.options.orders,{field,direction}]});}
  limit(limit) {return this.clone({limit});}
  startAfter(cursor) {return this.clone({cursor});}
  async get() {
    const {filters,orders,limit,cursor}=this.options;
    this.db.queries.push({name:this.name,...this.options,at:Date.now()});
    const fieldValue=(row,field)=>field==='__name__'?row.id:row.data()[field];
    const compareRows=(a,b)=>{
      for(const {field,direction} of orders) {
        const cmp=compare(fieldValue(a,field),fieldValue(b,field));
        if(cmp) return direction==='asc'?cmp:-cmp;
      }
      return 0;
    };
    let docs=[...(this.db.collections.get(this.name) || new Map()).entries()]
      .map(([id,data])=>({id,ref:this.doc(id),exists:true,data:()=>data}))
      .filter(row=>filters.every(({field,op,target})=>{
        const actual=row.data()[field];
        if(op==='==') return actual===target;
        if(op==='<=') return compare(actual,target)<=0;
        throw new Error(`Unsupported worker fake filter ${op}`);
      }))
      .filter(row=>orders.every(({field})=>fieldValue(row,field)!==undefined));
    docs.sort(compareRows);
    if(cursor) docs=docs.filter(row=>compareRows(row,cursor)>0);
    if(limit!==null) docs=docs.slice(0,limit);
    const snapshot={docs,empty:docs.length===0,size:docs.length};
    if(this.db.onQuery) await this.db.onQuery(snapshot,this.options);
    return snapshot;
  }
}

class WorkerFirestore extends FakeFirestore {
  constructor() {super();this.queries=[];this.onQuery=null;}
  collection(name) {return new WorkerQuery(this,name);}
}
module.exports={WorkerFirestore};
