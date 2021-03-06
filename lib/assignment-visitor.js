"use strict"

const getOption = require("./options.js").get
const utils = require("./utils.js")
const Visitor = require("./visitor.js")

class AssignmentVisitor extends Visitor {
  reset(rootPath, options) {
    this.exportedLocalNames = options.exportedLocalNames
    this.magicString = options.magicString
    this.moduleAlias = getOption(options, "moduleAlias")

    if (this.exportedLocalNames === void 0) {
      this.exportedLocalNames = Object.create(null)
    }
  }

  visitAssignmentExpression(path) {
    return assignmentHelper(this, path, "left")
  }

  visitCallExpression(path) {
    this.visitChildren(path)

    const callee = path.getValue().callee
    if (callee.type === "Identifier" &&
        callee.name === "eval") {
      wrap(this, path)
    }
  }

  visitUpdateExpression(path) {
    return assignmentHelper(this, path, "argument")
  }
}

function assignmentHelper(visitor, path, childName) {
  visitor.visitChildren(path)

  const child = path.getValue()[childName]
  const assignedNames = utils.getNamesFromPattern(child)
  const nameCount = assignedNames.length

  // Wrap assignments to exported identifiers with `module.runSetters`.
  for (let i = 0; i < nameCount; ++i) {
    if (visitor.exportedLocalNames[assignedNames[i]] === true) {
      wrap(visitor, path)
      break
    }
  }
}

function wrap(visitor, path) {
  const value = path.getValue()

  visitor.magicString
    .prependRight(value.start, visitor.moduleAlias + ".runSetters(")
    .appendLeft(value.end, ")")
}

module.exports = AssignmentVisitor
