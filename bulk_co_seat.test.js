// Round 6 regression: Bulk Seating by Date must co-seat compatible exams.
const h = require("./harness.js");
const api = h.load();
const s = h.suite("bulk_co_seat.test.js — shared physical hall allocation");
const { it, ait, eq, ok } = s;

function st(dept, year, n, prefix) {
  return Array.from({length:n},(_,i)=>({
    id:prefix+"-"+i, regno:prefix+String(i).padStart(4,"0"),
    name:dept+" "+i, dept:dept, year:year, gender:"male"
  }));
}
function hall(id,type,rows,seatsPerRow) {
  return {id:id,name:id,hallType:type||"CAT",numbenches:rows,studentsperbench:seatsPerRow||9};
}
function ex(id,dept,year) {
  return {id:id,subject:"CAT",subjectTitle:id,category:"CAT",date:"2026-10-14",session:"FN",
    status:"scheduled",groups:[{dept:dept,year:year}],seatinggenerated:false};
}
const rules={splitGender:true,noSameDept:true,noSameYear:false,benchAdjacency:false};

ait("17 AIDS males + 28 MECH males share LH-1 and fill its 45 seats",async()=>{
  const students=st("AIDS",2,17,"A").concat(st("MECH",2,28,"M"));
  const exams=[ex("A","AIDS",2),ex("M","MECH",2)];
  const saved={};
  const res=await api.runBulkSeating({exams:exams,allExams:exams,students:students,halls:[hall("LH-1","CAT",5,9)],
    rules:rules,coSeat:true,savePlan:async(id,plan,meta)=>{saved[id]={plan:plan,meta:meta};},loadPlan:async()=>null,
    confirmOverwrite:()=>true});
  eq(res.summary.completed,2);
  const a=saved.A.plan["LH-1"].seats, m=saved.M.plan["LH-1"].seats;
  eq(a.length,17); eq(m.length,28);
  const merged=a.concat(m);
  eq(merged.length,45);
  eq(new Set(merged.map(x=>x.seatNo)).size,45,"seat assignments must be disjoint");
  eq(saved.A.meta.hallids,["LH-1"],"first exam owns shared hall reservation");
  eq(saved.M.meta.hallids,[],"second exam shares physical seats without exclusive ownership");
  const problems=api.validatePlan({"LH-1":Object.assign({},saved.A.plan["LH-1"],{seats:merged})},{noSameDept:true});
  eq(problems,[],"merged plan has no prohibited same-department adjacent seats");
});

ait("a required plan read failure fails visibly and performs no writes",async()=>{
  const students=st("AIDS",2,2,"A").concat(st("MECH",2,2,"M"));
  const exams=[ex("A","AIDS",2),ex("M","MECH",2)];
  let writes=0;
  const res=await api.runBulkSeating({exams:exams,allExams:exams,students:students,halls:[hall("LH-1","CAT",5,9)],
    rules:rules,loadPlan:async()=>{throw new Error("read timeout");},savePlan:async()=>{writes++;}});
  eq(writes,0);
  eq(res.results.filter(r=>r.category==="DATA_LOAD_FAILED").length,2);
});

it("different sessions never co-seat",async()=>{
  const students=st("AIDS",2,2,"A").concat(st("MECH",2,2,"M"));
  const exams=[ex("FN","AIDS",2),Object.assign(ex("AN","MECH",2),{session:"AN"})];
  const saved={};
  const res=await api.runBulkSeating({exams:exams,allExams:exams,students:students,halls:[hall("LH-1","CAT",5,9)],
    rules:Object.assign({},rules,{splitGender:false,noSameDept:false}),coSeat:true,savePlan:async(id,p)=>{saved[id]=p;},loadPlan:async()=>null});
  eq(res.summary.completed,2);
  ok(saved.FN && saved.AN);
  eq(Object.keys(saved.FN["LH-1"]||{}).length>0,true);
  eq(Object.keys(saved.AN["LH-1"]||{}).length>0,true);
});

module.exports=s;
