## Objectify Params

Automatically refactor JavaScript or TypeScript functions to use object parameters instead of multiple positional parameters, improving readability and maintainability.

### Features

- **Automatic Refactoring**: Converts function signature and all call sites across your workspace
- **Smart Detection**: Identifies confirmed safe conversions and asks about uncertain cases
- **Preview Mode**: Optional preview dialogs to review each change before applying
- **Workspace-Wide**: Scans and updates all matching files in your project
- **Type-Safe**: Preserves TypeScript types, optional parameters, and function return types

![Objectifying One Parameter List (Delay exaggerated)](images/intro.gif)

*Objectifying One Function's Parameter List. Preview walkthrough is optional.*

### Usage

1. Place your cursor inside a function definition.
2. Right-click and select **"Objectify Parameters"** or use the Command Palette. You can assign your own hot-key.
3. Review any uncertain conversions in interactive dialogs.
4. The extension updates both the function signature and all call sites.

#### Before
```typescript
function createUser(name: string, age: number, email?: string) {
  return { name, age, email };
}

createUser("Alice", 30, "alice@example.com");
createUser("Bob", 25);
```

#### After
```typescript
function createUser({ name, age, email }: { name: string; age: number; email?: string }) {
  return { name, age, email };
}

createUser({ name: "Alice", age: 30, email: "alice@example.com" });
createUser({ name: "Bob", age: 25 });
```

### Configuration

Access settings via **File > Preferences > Settings** and search for "Objectify Parameters":

#### `objectifyParams.include`
- **Type**: `string`
- **Default**: `"**/*.ts **/*.js"`
- Space-separated glob patterns of files to scan

#### `objectifyParams.exclude`
- **Type**: `string`
- **Default**: `"**/node_modules/**"`
- Space-separated glob patterns to exclude

#### `objectifyParams.monitorConversions`
- **Type**: `boolean`
- **Default**: `false`
- Show preview dialog for every call conversion (including confirmed safe calls)

#### `objectifyParams.highlightDelay`
- **Type**: `number`
- **Default**: `500`
- **Range**: 0-5000ms
- Duration to show preview highlights. Set to `0` to show only the dialog without delay

### How It Works

1. **Scanning**: Searches your workspace for all references to the function
2. **Classification**: Categorizes calls as:
   - **Confirmed**: Safe to convert automatically
   - **Fuzzy**: Requires user review (name collisions, argument mismatches, etc.)
   - **Incompatible**: Cannot convert (call/apply/bind, spread arguments)
3. **Interactive Review**: Shows dialogs for fuzzy cases where you choose Convert or Skip
4. **Application**: Updates function signature and all approved call sites
5. **Verification**: Highlights the updated function signature

### Supported File Types

- TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`)
- JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`)
- Vue (`.vue`)
- Svelte (`.svelte`)

### Requirements

- VS Code 1.50.0 or higher
- Works with both JavaScript and TypeScript projects

### Known Limitations

- Cannot convert functions called with `.call()`, `.apply()`, or `.bind()`
- Cannot convert functions called with spread arguments (`...args`)
- Rest parameters must use tuple syntax for type preservation

### Tips

- **Monitor Mode**: Enable `monitorConversions` to review every conversion step-by-step
- **Fast Mode**: Set `highlightDelay` to `0` for instant dialogs without preview delays
- **Selective Scanning**: Adjust `include` patterns to limit scope for faster processing
- **Undo Support**: All changes are applied through VS Code's undo system

### License

MIT

### Links

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=eridien.objectify-params)
- [GitHub Repository](https://github.com/mark-hahn/vscode-objectify-params)

### Contributing

Issues and pull requests welcome at the [GitHub repository](https://github.com/mark-hahn/vscode-objectify-params).
