const { report } = require("./harness.js");
const suites = [
  require("./cat.test.js"),
  require("./cat_ocr.test.js"),
  require("./cat_words.test.js"),
  require("./cat_ink.test.js"),
  require("./cat_pipeline.test.js"),
  require("./cat_core.test.js"),
  require("./cat_corpus.test.js"),
  require("./cat_corpus_gen.test.js"),
  require("./cat_table_pdf.test.js"),
  require("./cat_bench_adjacency.test.js"),
  require("./cat_edit.test.js"),
  require("./tests/cat_llm.test.js"),
  require("./subjects_import.test.js"),
  require("./cat_json_import.test.js"),
];
report(suites).then((fail) => process.exit(fail ? 1 : 0));