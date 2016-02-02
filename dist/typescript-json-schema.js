var ts = require("typescript");
var glob = require("glob");
var vm = require("vm");
var TJS;
(function (TJS) {
    class JsonSchemaGenerator {
        constructor(allSymbols, inheritingTypes, tc, useRef = false) {
            this.useRef = useRef;
            this.sandbox = { sandboxvar: null };
            this.reffedDefinitions = {};
            this.allSymbols = allSymbols;
            this.inheritingTypes = inheritingTypes;
            this.tc = tc;
        }
        get ReffedDefinitions() {
            return this.reffedDefinitions;
        }
        copyValidationKeywords(comment, to) {
            JsonSchemaGenerator.annotedValidationKeywordPattern.lastIndex = 0;
            let annotation;
            while ((annotation = JsonSchemaGenerator.annotedValidationKeywordPattern.exec(comment))) {
                const annotationTokens = annotation[0].split(" ");
                let keyword = annotationTokens[0].slice(1);
                const path = keyword.split(".");
                let context = null;
                if (path.length > 1) {
                    context = path[0];
                    keyword = path[1];
                }
                keyword = keyword.replace("TJS-", "");
                if (JsonSchemaGenerator.validationKeywords.indexOf(keyword) >= 0 || JsonSchemaGenerator.validationKeywords.indexOf("TJS-" + keyword) >= 0) {
                    let value = annotationTokens.length > 1 ? annotationTokens.slice(1).join(" ") : "";
                    value = value.replace(/^\s+|\s+$/gm, "");
                    try {
                        value = JSON.parse(value);
                    }
                    catch (e) { }
                    if (context) {
                        if (!to[context]) {
                            to[context] = {};
                        }
                        to[context][keyword] = value;
                    }
                    else {
                        to[keyword] = value;
                    }
                }
            }
        }
        copyDescription(comment, to) {
            const delimiter = "@";
            const delimiterIndex = comment.indexOf(delimiter);
            const description = comment.slice(0, delimiterIndex < 0 ? comment.length : delimiterIndex);
            if (description.length > 0) {
                to.description = description.replace(/\s+$/g, "");
            }
            return delimiterIndex < 0 ? "" : comment.slice(delimiterIndex);
        }
        parseCommentsIntoDefinition(comments, definition) {
            if (!comments || !comments.length) {
                return;
            }
            let joined = comments.map(comment => comment.text.trim()).join("\n");
            joined = this.copyDescription(joined, definition);
            this.copyValidationKeywords(joined, definition);
        }
        getDefinitionForType(propertyType, tc) {
            if (propertyType.flags & 16384) {
                const unionType = propertyType;
                const oneOf = unionType.types.map((propType) => {
                    return this.getDefinitionForType(propType, tc);
                });
                return {
                    "oneOf": oneOf
                };
            }
            const propertyTypeString = tc.typeToString(propertyType, undefined, 128);
            let definition = {};
            switch (propertyTypeString.toLowerCase()) {
                case "string":
                    definition.type = "string";
                    break;
                case "number":
                    definition.type = "number";
                    break;
                case "boolean":
                    definition.type = "boolean";
                    break;
                case "any":
                    definition.type = "object";
                    break;
                default:
                    if (propertyType.getSymbol().getName() == "Array") {
                        const arrayType = propertyType.typeArguments[0];
                        definition.type = "array";
                        definition.items = this.getDefinitionForType(arrayType, tc);
                    }
                    else {
                        const definition = this.getClassDefinition(propertyType, tc);
                        return definition;
                    }
            }
            return definition;
        }
        getDefinitionForProperty(prop, tc, node) {
            const propertyName = prop.getName();
            const propertyType = tc.getTypeOfSymbolAtLocation(prop, node);
            const propertyTypeString = tc.typeToString(propertyType, undefined, 128);
            let definition = this.getDefinitionForType(propertyType, tc);
            definition.title = propertyName;
            const comments = prop.getDocumentationComment();
            this.parseCommentsIntoDefinition(comments, definition);
            if (definition.hasOwnProperty("ignore")) {
                return null;
            }
            let initial = prop.valueDeclaration.initializer;
            if (initial) {
                if (initial.expression) {
                    console.warn("initializer is expression for property " + propertyName);
                }
                else if (initial.kind && initial.kind == 11) {
                    definition.default = initial.getText();
                }
                else {
                    try {
                        const sandbox = { sandboxvar: null };
                        vm.runInNewContext("sandboxvar=" + initial.getText(), sandbox);
                        initial = sandbox.sandboxvar;
                        if (initial == null) {
                        }
                        else if (typeof (initial) === "string" || typeof (initial) === "number" || typeof (initial) === "boolean" || Object.prototype.toString.call(initial) === '[object Array]') {
                            definition.default = initial;
                        }
                        else {
                            console.warn("unknown initializer for property " + propertyName + ": " + initial);
                        }
                    }
                    catch (e) {
                        console.warn("exception evaluating initializer for property " + propertyName);
                    }
                }
            }
            return definition;
        }
        getClassDefinition(clazzType, tc, asRef = this.useRef) {
            const node = clazzType.getSymbol().getDeclarations()[0];
            const clazz = node;
            const props = tc.getPropertiesOfType(clazzType);
            const fullName = tc.typeToString(clazzType, undefined, 128);
            if (clazz.flags & 256) {
                const oneOf = this.inheritingTypes[fullName].map((typename) => {
                    return this.getClassDefinition(this.allSymbols[typename], tc);
                });
                const definition = {
                    "oneOf": oneOf
                };
                return definition;
            }
            else {
                const propertyDefinitions = props.reduce((all, prop) => {
                    const propertyName = prop.getName();
                    const definition = this.getDefinitionForProperty(prop, tc, node);
                    if (definition != null) {
                        all[propertyName] = definition;
                    }
                    return all;
                }, {});
                const required = props.filter((prop) => {
                    return (prop.flags & 536870912) === 0 &&
                        (prop.flags & (4 | 3 | 98304)) === 1;
                }).map((prop) => {
                    return prop.name;
                });
                const definition = {
                    type: "object",
                    title: fullName,
                    defaultProperties: [],
                    properties: propertyDefinitions,
                    required: required
                };
                if (required.length === 0) {
                    delete definition.required;
                }
                if (asRef) {
                    this.reffedDefinitions[fullName] = definition;
                    return {
                        "$ref": "#/definitions/" + fullName
                    };
                }
                else {
                    return definition;
                }
            }
        }
        getClassDefinitionByName(clazzName, includeReffedDefinitions = true) {
            let def = this.getClassDefinition(this.allSymbols[clazzName], this.tc);
            if (this.useRef && includeReffedDefinitions) {
                def.definitions = this.reffedDefinitions;
            }
            return def;
        }
    }
    JsonSchemaGenerator.validationKeywords = [
        "ignore", "description", "type", "minimum", "exclusiveMinimum", "maximum",
        "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "format",
        "pattern", "minItems", "maxItems", "uniqueItems", "default",
        "additionalProperties", "enum"];
    JsonSchemaGenerator.annotedValidationKeywordPattern = /@[a-z.-]+\s*[^@]+/gi;
    function generateSchema(compileFiles, fullTypeName) {
        const options = { noEmit: true, emitDecoratorMetadata: true, experimentalDecorators: true, target: 1, module: 1 };
        const program = ts.createProgram(compileFiles, options);
        const tc = program.getTypeChecker();
        var diagnostics = [
            ...program.getGlobalDiagnostics(),
            ...program.getDeclarationDiagnostics(),
            ...program.getSemanticDiagnostics()
        ];
        if (diagnostics.length == 0) {
            const allSymbols = {};
            const inheritingTypes = {};
            program.getSourceFiles().forEach(sourceFile => {
                function inspect(node, tc) {
                    if (node.kind == 212 || node.kind == 213) {
                        const nodeType = tc.getTypeAtLocation(node);
                        const fullName = tc.typeToString(nodeType, undefined, 128);
                        allSymbols[fullName] = nodeType;
                        nodeType.getBaseTypes().forEach(baseType => {
                            const baseName = tc.typeToString(baseType, undefined, 128);
                            if (!inheritingTypes[baseName]) {
                                inheritingTypes[baseName] = [];
                            }
                            inheritingTypes[baseName].push(fullName);
                        });
                    }
                    else {
                        ts.forEachChild(node, (node) => inspect(node, tc));
                    }
                }
                inspect(sourceFile, tc);
            });
            const useRef = true;
            const generator = new JsonSchemaGenerator(allSymbols, inheritingTypes, tc, useRef);
            let definition = generator.getClassDefinitionByName(fullTypeName);
            definition["$schema"] = "http://json-schema.org/draft-04/schema#";
            return definition;
        }
        else {
            diagnostics.forEach((diagnostic) => console.warn(diagnostic.messageText + " " + diagnostic.file.fileName + " " + diagnostic.start));
        }
    }
    TJS.generateSchema = generateSchema;
    function exec(filePattern, fullTypeName) {
        const files = glob.sync(filePattern);
        const definition = TJS.generateSchema(files, fullTypeName);
        console.log(JSON.stringify(definition, null, 4));
    }
    TJS.exec = exec;
})(TJS = exports.TJS || (exports.TJS = {}));
if (typeof window === "undefined" && require.main === module) {
    if (process.argv[3]) {
        TJS.exec(process.argv[2], process.argv[3]);
    }
    else {
        console.log("Usage: node typescript-json-schema.js <path-to-typescript-files> <type>\n");
    }
}
//# sourceMappingURL=typescript-json-schema.js.map