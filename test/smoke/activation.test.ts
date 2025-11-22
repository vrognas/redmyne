import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Activation", () => {
  test("Should load and activate extension", async function () {
    this.timeout(30000);

    // Wait for extension to be available
    let ext = vscode.extensions.getExtension("vrognas.positron-redmine");

    // If not found immediately, wait a bit (extension might be loading)
    if (!ext) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      ext = vscode.extensions.getExtension("vrognas.positron-redmine");
    }

    assert.ok(ext, "Extension not found in vscode.extensions");

    if (!ext.isActive) {
      await ext.activate();
    }

    assert.strictEqual(
      ext.isActive,
      true,
      "Extension failed to activate"
    );
  });
});
