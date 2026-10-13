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

ait("17 AIDS males + 28 MECH males share LH-1; largest-first leaves a 2-AIDS tail that honestly fails the slot (nothing saved)", async () => {
  // COLUMN-WISE MODE (approved design): LH-1's 5-row layout creates vertical
  // columns that must each hold exactly ONE department, and the allocator commits
  // each column to the department with the LARGEST remaining demand. MECH (28)
  // takes columns A-E fully plus six rows of F; AIDS (17) fills G-I. 17 + 28 do
  // not tile into full columns on this hall's geometry, so the merged co-seat run
  // seats 43 and honestly leaves a 2-AIDS tail unplaced. Because unplaced
  // students exist, the CAT import refuses to save partial plans: the slot fails
  // and NOTHING is persisted — the admin is never shown a seated-but-mixed plan.
  const students = st("AIDS", 2, 17, "A").concat(st("MECH", 2, 28, "M"));
  const exams = [ex("A", "AIDS", 2), ex("M", "MECH", 2)];
  const saved = {};
  const res = await api.runBulkSeating({exams:exams,allExams:exams,students:students,halls:[hall("LH-1","CAT",5,9)],
    rules:rules,coSeat:true,savePlan:async(id,plan,meta)=>{saved[id]={plan:plan,meta:meta};},loadPlan:async()=>null,
    confirmOverwrite:()=>true});
  eq(res.summary.completed, 0, "no planar exam saved when the co-seated slot has unplaced students");
  eq(res.summary.failed, 2, "both exams of the slot fail together");
  eq(res.summary.unplaced, 2, "the 2-AIDS column tail is honestly reported unplaced");
  eq(Object.keys(saved).length, 0, "nothing is written for the failed slot");
  const upDepts = (res.results || []).flatMap(function (r) { return (r.unplaced || []).map(function (x) { return x.dept || (x.student && x.student.dept); }); });
  eq(upDepts.filter(function (d) { return d === "AIDS"; }).length, 2, "the unplaced students are all AIDS");
  ok((res.results || []).every(function (r) { return r.reason.indexOf("could not be placed legally") >= 0; }),
    "the failure is the honest partial-placement refusal (" + ((res.results || [])[0] || {}).reason + ")");
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
