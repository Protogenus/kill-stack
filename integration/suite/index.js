// Entry point VS Code loads inside the extension host. It runs the Mocha suites.
const path = require("path");
const Mocha = require("mocha");

function run() {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30000 });
  mocha.addFile(path.join(__dirname, "smoke.js"));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };
