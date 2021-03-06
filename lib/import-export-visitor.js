"use strict"

const assert = require("assert")
const getOption = require("./options.js").get
const MagicString = require("./magic-string.js")
const utils = require("./utils.js")
const Visitor = require("./visitor.js")

const codeOfCR = "\r".charCodeAt(0)

class ImportExportVisitor extends Visitor {
  finalizeHoisting() {
    const infoCount = this.bodyInfos.length

    for (let i = 0; i < infoCount; ++i) {
      const bodyInfo = this.bodyInfos[i]
      let codeToInsert = bodyInfo.hoistedPrefixString

      if (bodyInfo.parent.type === "Program" &&
          this.moduleAlias !== "module") {
        codeToInsert +=
          (this.generateLetDeclarations ? "const " : "var ") +
          this.moduleAlias + "=module;"
      }

      codeToInsert +=
        toModuleExport(this, bodyInfo.hoistedExportsMap, false) +
        toModuleExport(this, bodyInfo.hoistedConstExportsMap, true) +
        bodyInfo.hoistedExportsString +
        bodyInfo.hoistedImportsString

      if (codeToInsert) {
        this.magicString.prependRight(bodyInfo.insertCharIndex, codeToInsert)
      }

      delete bodyInfo.parent._bodyInfoByName
    }

    // Just in case we call finalizeHoisting again, don't hoist anything.
    this.bodyInfos.length = 0
  }

  reset(rootPath, code, options) {
    this.code = code
    this.magicString = new MagicString(code)

    this.bodyInfos = []
    this.exportedLocalNames = Object.create(null)
    this.generateLetDeclarations = !! getOption(options, "generateLetDeclarations")
    this.madeChanges = false
    this.moduleAlias = getOption(options, "moduleAlias")
    this.nextKey = 0
    this.parse = getOption(options, "parse")
    this.removals = []
    this.sourceType = getOption(options, "sourceType")
  }

  visitProgram(path) {
    this.visitChildren(path)
    const program = path.getNode()
    if (program.body.length) {
      path.call(
        (firstStmtPath) => getBlockBodyInfo(this, firstStmtPath),
        "body", 0
      )
    } else {
      getBlockBodyInfo(this, path)
    }
  }

  visitCallExpression(path) {
    const node = path.getNode()
    const callee = node.callee

    if (callee.type === "Import") {
      overwrite(this, callee.start, callee.end, this.moduleAlias + ".import")
    }

    this.visitChildren(path)
  }

  visitImportDeclaration(path) {
    const decl = path.getValue()
    const specifierCount = decl.specifiers.length
    const namespaces = []
    let hoistedCode = ""

    if (specifierCount) {
      const identifiers = []

      for (let i = 0; i < specifierCount; ++i) {
        const s = decl.specifiers[i]
        const name = s.local.name

        if (s.type === "ImportNamespaceSpecifier") {
          namespaces.push(name)
        } else {
          identifiers.push(name)
        }
      }

      const identifierCount = identifiers.length
      if (identifierCount) {
        const lastIndex = identifierCount - 1
        hoistedCode += this.generateLetDeclarations ? "let " : "var "

        for (let i = 0; i < identifierCount; ++i) {
          const isLast = i === lastIndex
          hoistedCode +=
            identifiers[i] +
            (isLast ? ";" : ",")
        }
      }

      const namespaceCount = namespaces.length
      if (namespaceCount) {
        const lastIndex = namespaceCount - 1
        hoistedCode += this.generateLetDeclarations ? "const " : "var "

        for (let i = 0; i < namespaceCount; ++i) {
          const isLast = i === lastIndex
          hoistedCode +=
            namespaces[i] +
            "=Object.create(null)" +
            (isLast ? ";" : ",")
        }
      }
    }

    hoistedCode += toModuleImport(
      this,
      getSourceString(this, decl),
      computeSpecifierMap(decl.specifiers),
      namespaces
    )

    hoistImports(this, path, hoistedCode)
  }

  visitExportAllDeclaration(path) {
    const decl = path.getValue()
    const hoistedCode = pad(
      this,
      this.moduleAlias + ".watch(require(" + getSourceString(this, decl) + ")",
      decl.start,
      decl.source.start
    ) + pad(
      this,
      ',{"*"(v,k){exports[k]=v}},' +
        makeUniqueKey(this) + ");",
      decl.source.end,
      decl.end
    )

    hoistExports(this, path, hoistedCode)
  }

  visitExportDefaultDeclaration(path) {
    const decl = path.getValue()
    const dd = decl.declaration

    if (dd.id && (dd.type === "FunctionDeclaration" ||
                  dd.type === "ClassDeclaration")) {
      // If the exported default value is a function or class declaration,
      // it's important that the declaration be visible to the rest of the
      // code in the exporting module, so we must avoid compiling it to a
      // named function or class expression.
      hoistExports(this, path, {
        "default": [dd.id.name]
      }, "declaration")

    } else {
      // Otherwise, since the exported value is an expression, we use the
      // special module.exportDefault(value) form.

      path.call(this.visitWithoutReset, "declaration")
      assert.strictEqual(decl.declaration, dd)

      let prefix = this.moduleAlias + ".exportDefault("
      let suffix = ");"

      if (dd.type === "SequenceExpression") {
        // If the exported expression is a comma-separated sequence
        // expression, this.code.slice(dd.start, dd.end) may not include
        // the vital parentheses, so we should wrap the expression with
        // parentheses to make absolutely sure it is treated as a single
        // argument to the module.exportDefault method, rather than as
        // multiple arguments.
        prefix += "("
        suffix = ")" + suffix
      }

      overwrite(this, decl.start, dd.start, prefix)
      overwrite(this, dd.end, decl.end, suffix, true)
    }
  }

  visitExportNamedDeclaration(path) {
    const decl = path.getValue()
    const dd = decl.declaration

    if (dd) {
      const specifierMap = Object.create(null)
      const type = dd.type

      if (dd.id && (type === "ClassDeclaration" ||
                    type === "FunctionDeclaration")) {
        addNameToMap(specifierMap, dd.id.name)
      } else if (type === "VariableDeclaration") {
        const ddCount = dd.declarations.length

        for (let i = 0; i < ddCount; ++i) {
          const names = utils.getNamesFromPattern(dd.declarations[i].id)
          const nameCount = names.length

          for (let j = 0; j < nameCount; ++j) {
            addNameToMap(specifierMap, names[j])
          }
        }
      }

      hoistExports(this, path, specifierMap, "declaration")

      if (canExportedValuesChange(decl)) {
        // We can skip adding declared names to this.exportedLocalNames if
        // the declaration was a const-kinded VariableDeclaration, because
        // the assignmentVisitor will not need to worry about changes to
        // these variables.
        addExportedLocalNames(this, specifierMap)
      }

      return
    }

    if (decl.specifiers) {
      let specifierMap = computeSpecifierMap(decl.specifiers)

      if (decl.source) {
        if (specifierMap) {
          const newMap = Object.create(null)
          const exportedNames = Object.keys(specifierMap)
          const nameCount = exportedNames.length

          for (let i = 0; i < nameCount; ++i) {
            const exported = exportedNames[i]
            const locals = specifierMap[exported]
            const localCount = locals.length

            for (let j = 0; j < localCount; ++j) {
              addToSpecifierMap(newMap, locals[j], "exports." + exported)
            }
          }

          specifierMap = newMap
        }

        // Even though the compiled code uses module.watch, it should
        // still be hoisted as an export, i.e. before actual imports.
        hoistExports(this, path, toModuleImport(
          this,
          getSourceString(this, decl),
          specifierMap
        ))

      } else {
        hoistExports(this, path, specifierMap)
        addExportedLocalNames(this, specifierMap)
      }
    }
  }
}

function addExportedLocalNames(visitor, specifierMap) {
  const exportedLocalNames = visitor.exportedLocalNames
  const exportedNames = Object.keys(specifierMap)
  const nameCount = exportedNames.length

  for (let i = 0; i < nameCount; ++i) {
    const exported = exportedNames[i]
    const locals = specifierMap[exported]
    const localCount = locals.length

    for (let j = 0; j < localCount; ++j) {
      // It's tempting to record the exported name as the value here,
      // instead of true, but there can be more than one exported name
      // per local variable, and we don't actually use the exported
      // name(s) in the assignmentVisitor, so it's not worth the added
      // complexity of tracking unused information.
      exportedLocalNames[locals[j]] = true
    }
  }
}

function addNameToMap(map, name) {
  addToSpecifierMap(map, name, name)
}

function addToSpecifierMap(map, __ported, local) {
  const locals = __ported in map ? map[__ported] : []

  if (locals.indexOf(local) < 0) {
    locals.push(local)
  }

  map[__ported] = locals
  return map
}

// Returns a map from {im,ex}ported identifiers to lists of local variable
// names bound to those identifiers.
function computeSpecifierMap(specifiers) {
  const specifierCount = specifiers.length
  const specifierMap = Object.create(null)

  for (let i = 0; i < specifierCount; ++i) {
    const s = specifiers[i]

    const local =
      s.type === "ExportDefaultSpecifier" ? "default" :
      s.type === "ExportNamespaceSpecifier" ? "*" :
      s.local.name

    const __ported = // The IMported or EXported name.
      s.type === "ImportSpecifier" ? s.imported.name :
      s.type === "ImportDefaultSpecifier" ? "default" :
      s.type === "ImportNamespaceSpecifier" ? "*" :
      (s.type === "ExportSpecifier" ||
       s.type === "ExportDefaultSpecifier" ||
       s.type === "ExportNamespaceSpecifier") ? s.exported.name :
      null

    if (typeof local === "string" && typeof __ported === "string") {
      addToSpecifierMap(specifierMap, __ported, local)
    }
  }

  return specifierMap
}

function getBlockBodyInfo(visitor, path) {
  const node = path.getNode()
  let parent = path.getParentNode()

  if (parent === null) {
    parent = node
  }

  let body = parent.body
  let bodyName = "body"
  let insertCharIndex = node.start

  switch (parent.type) {
  case "Program":
    insertCharIndex = parent.start
    break

  case "BlockStatement":
    insertCharIndex = parent.start + 1
    break

  case "SwitchCase":
    body = parent.consequent
    bodyName = "consequent"
    insertCharIndex = body[0].start
    break

  default:
    const block = {
      type: "BlockStatement",
      body: [],
      start: node.start,
      end: node.end + 2
    }

    body = block.body
    bodyName = path.getName()
    insertCharIndex = node.start

    visitor.magicString
      .appendLeft(insertCharIndex, "{")
      .prependRight(node.end, "}")
  }

  assert.ok(Array.isArray(body), body)

  // Avoid hoisting above string literal expression statements such as
  // "use strict", which may depend on occurring at the beginning of
  // their enclosing scopes.
  let insertNodeIndex = 0
  let hoistedPrefixString = ""

  if (body.length > 0) {
    const stmt = body[0];
    if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression
      if (expr.type === "Literal" &&
          typeof expr.value === "string") {
        insertCharIndex = stmt.end
        insertNodeIndex = 1
        hoistedPrefixString = ";"
      }
    }
  }

  let bibn = parent._bodyInfoByName

  if (bibn === void 0) {
    bibn = parent._bodyInfoByName = Object.create(null)
  }

  let bodyInfo = bibn[bodyName]

  if (bodyInfo === void 0) {
    bodyInfo = bibn[bodyName] = Object.create(null)
    bodyInfo.body = body
    bodyInfo.insertCharIndex = insertCharIndex
    bodyInfo.insertNodeIndex = insertNodeIndex
    bodyInfo.hoistedConstExportsMap = Object.create(null)
    bodyInfo.hoistedExportsMap = Object.create(null)
    bodyInfo.hoistedExportsString = ""
    bodyInfo.hoistedImportsString = ""
    bodyInfo.hoistedPrefixString = hoistedPrefixString
    bodyInfo.parent = parent

    visitor.bodyInfos.push(bodyInfo)
  }

  return bodyInfo
}

// Gets a string representation (including quotes) from an import or
// export declaration node.
function getSourceString(visitor, decl) {
  if (visitor.code) {
    return visitor.code.slice(decl.source.start, decl.source.end)
  }
  return JSON.stringify(decl.source.value)
}

function hoistImports(visitor, importDeclPath, hoistedCode) {
  preserveLine(visitor, importDeclPath)
  const bodyInfo = getBlockBodyInfo(visitor, importDeclPath)
  bodyInfo.hoistedImportsString += hoistedCode
}

function hoistExports(visitor, exportDeclPath, mapOrString, childName) {
  if (childName) {
    preserveChild(visitor, exportDeclPath, childName)
  } else {
    preserveLine(visitor, exportDeclPath)
  }

  const bodyInfo = getBlockBodyInfo(visitor, exportDeclPath)

  if (typeof mapOrString === "string") {
    bodyInfo.hoistedExportsString += mapOrString
    return
  }

  const constant = ! canExportedValuesChange(exportDeclPath.getValue())
  const exportedNames = Object.keys(mapOrString)
  const nameCount = exportedNames.length

  for (let i = 0; i < nameCount; ++i) {
    const exported = exportedNames[i]
    const locals = mapOrString[exported]
    const localCount = locals.length

    for (let j = 0; j < localCount; ++j) {
      addToSpecifierMap(
        constant
          ? bodyInfo.hoistedConstExportsMap
          : bodyInfo.hoistedExportsMap,
        exported,
        locals[j]
      )
    }
  }
}

function canExportedValuesChange(exportDecl) {
  if (exportDecl) {
    if (exportDecl.type === "ExportDefaultDeclaration") {
      const dd = exportDecl.declaration
      return (dd.type === "FunctionDeclaration" ||
              dd.type === "ClassDeclaration")
    }

    if (exportDecl.type === "ExportNamedDeclaration") {
      const dd = exportDecl.declaration
      if (dd &&
          dd.type === "VariableDeclaration" &&
          dd.kind === "const") {
        return false
      }
    }
  }

  return true
}

function makeUniqueKey(visitor) {
  return visitor.nextKey++
}

function overwrite(visitor, oldStart, oldEnd, newCode, trailing) {
  if (! visitor.code) {
    return
  }

  const padded = pad(visitor, newCode, oldStart, oldEnd)

  if (oldStart !== oldEnd) {
    visitor.madeChanges = true
    visitor.magicString.overwrite(oldStart, oldEnd, padded)
    return
  }

  if (padded === "") {
    return
  }

  visitor.madeChanges = true
  if (trailing) {
    visitor.magicString.appendLeft(oldStart, padded)
  } else {
    visitor.magicString.prependRight(oldStart, padded)
  }
}

function pad(visitor, newCode, oldStart, oldEnd) {
  if (! visitor.code) {
    return newCode
  }

  const oldLines = visitor.code.slice(oldStart, oldEnd).split("\n")
  const oldLineCount = oldLines.length
  const newLines = newCode.split("\n")
  const lastIndex = newLines.length - 1

  for (let i = lastIndex; i < oldLineCount; ++i) {
    const oldLine = oldLines[i]
    const lastCharCode = oldLine.charCodeAt(oldLine.length - 1)

    if (i > lastIndex) {
      newLines[i] = ""
    }
    if (lastCharCode === codeOfCR) {
      newLines[i] += "\r"
    }
  }

  return newLines.join("\n")
}

function preserveChild(visitor, path, childName) {
  const value = path.getValue()
  const child = value ? value[childName] : null

  if (child && visitor.code) {
    overwrite(
      visitor,
      value.start,
      child.start,
      ""
    )
    overwrite(
      visitor,
      child.end,
      value.end,
      ""
    )
  }

  path.call(visitor.visitWithoutReset, childName)
}

function preserveLine(visitor, path) {
  if (visitor.code) {
    const value = path.getValue()
    overwrite(visitor, value.start, value.end, "")
  }
}

function safeKey(key) {
  if (/^[_$a-zA-Z]\w*$/.test(key)) {
    return key
  }
  return JSON.stringify(key)
}

function safeParam(param, locals) {
  if (locals.indexOf(param) < 0) {
    return param
  }
  return safeParam("_" + param, locals)
}

function toModuleImport(visitor, code, specifierMap, namespaces) {
  const importedNames = Object.keys(specifierMap)
  const nameCount = importedNames.length

  code = visitor.moduleAlias + ".watch(require(" + code + ")"

  if (! nameCount) {
    code += ");"
    return code
  }

  const lastIndex = nameCount - 1
  let namespaceList = Array.isArray(namespaces) ? namespaces.join(",") : ""
  const searchExports = ! namespaceList

  code += ",{"

  for (let i = 0; i < nameCount; ++i) {
    const imported = importedNames[i]
    const isLast = i === lastIndex
    const locals = specifierMap[imported]
    const localCount = locals.length
    const localLastIndex = localCount - 1
    const valueParam = safeParam("v", locals)

    // Generate plain functions, instead of arrow functions, to avoid a perf
    // hit in Node 4.
    code += safeKey(imported) + "(" + valueParam

    if (imported === "*") {
      // When the imported name is "*", the setter function may be called
      // multiple times, and receives an additional parameter specifying
      // the name of the property to be set.
      const nameParam = safeParam("n", locals)
      code += "," + nameParam + "){"

      for (let j = 0; j < localCount; ++j) {
        const local = locals[j]

        if (searchExports && local.startsWith("exports.")) {
          code = locals[localLastIndex - j] + "=Object.create(null);" + code
          namespaceList += (namespaceList ? "," : "") + local
        }
        // The local variable should have been initialized as an empty
        // object when the variable was declared.
        code += local + "[" + nameParam + "]="
      }
      code += valueParam
    } else {
      // Multiple local variables become a compound assignment.
      code += "){" + locals.join("=") + "=" + valueParam
    }

    code += "}"

    if (! isLast) {
      code += ","
    }
  }

  code += "}," + makeUniqueKey(visitor)

  if (namespaceList) {
    code += ",[" + namespaceList + "]"
  }

  code += ");"

  return code
}

function toModuleExport(visitor, specifierMap, constant) {
  const exportedNames = Object.keys(specifierMap)
  const nameCount = exportedNames.length

  let code = ""

  if (! nameCount) {
    return code
  }

  const lastIndex = nameCount - 1
  code += visitor.moduleAlias + ".export({"

  for (let i = 0; i < nameCount; ++i) {
    const exported = exportedNames[i]
    const isLast = i === lastIndex
    const locals = specifierMap[exported]

    assert.strictEqual(locals.length, 1)

    code += exported + ":()=>" + locals[0]

    if (! isLast) {
      code += ","
    }
  }

  // The second argument to module.export indicates whether the getter
  // functions provided in the first argument are constant or not.
  code += constant ? "},true);" : "});"

  return code
}

module.exports = ImportExportVisitor
