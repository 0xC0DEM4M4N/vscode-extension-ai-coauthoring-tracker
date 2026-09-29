# AI Co-Authoring Tracker - Installation Files

This folder contains pre-built VSIX files ready to install into VS Code.

## Quick Install

1. Download the latest `.vsix` file from this folder
2. In VS Code, open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Select `Extensions: Install from VSIX...`
4. Choose the downloaded `.vsix` file
5. Reload VS Code

## Building a New VSIX File

From the parent directory (`vscode-extension-ai-coauthor/`), run:

```bash
npm install
npm run build-install
```

This will:
1. Compile the extension
2. Clean the install folder
3. Generate the VSIX package
4. Move it into this `install/` folder

## Installing as a Repo-Recommended Extension

To have VS Code prompt everyone who opens this repo to install the extension automatically:

1. Build the VSIX as above so a `.vsix` file exists in this folder.
2. Add a workspace task (or run it manually) that installs it via the CLI:

   ```bash
   code --install-extension vscode-extension-ai-coauthor/install/<file>.vsix
   ```

3. Since local VSIX extensions can't be listed in `.vscode/extensions.json` recommendations (that file only supports Marketplace IDs), document the install command in the repo `README.md`/`CONTRIBUTING.md` so new contributors run it once after cloning.

## Notes

- VSIX files in this folder are committed to the repository for easy distribution
- Always build from the latest source code in the parent directory
- Update this folder when releasing new versions
