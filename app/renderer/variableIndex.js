// Scans the ink source of a whole project to find every global
// variable (VAR, CONST, LIST) and every place it's read or set,
// grouped by the knot/stitch that it happens in.
//
// This is a lightweight text scanner rather than a full parser: it tries
// to only look at "code" parts of a line (~ logic, {inline logic}, choice
// conditions, multi-line conditions and divert arguments) so that a variable
// called "health" isn't matched when it appears in prose.

const sequenceKeywordRegex = /^\s*(stopping|cycle|shuffle(\s+once|\s+stopping)?|once)\s*:/;
const identifierRegex = /[A-Za-z_]\w*/g;
const writeOperatorRegex = /^\s*(=(?!=)|\+=|-=|\+\+|--)/;

function scanProject(files) {

    var variables = {};
    var flowsByFile = {};

    // Pass 1: Declarations, so that we know which names to look for
    files.forEach(file => {
        var lines = stripComments(file.text);
        lines.forEach((line, row) => {
            var decl = line.match(/^\s*(VAR|CONST|LIST)\s+(\w+)\s*=\s*(.*)$/);
            if( !decl ) return;

            var name = decl[2];
            if( variables[name] ) return; // duplicate - compiler will complain anyway

            variables[name] = {
                name: name,
                kind: decl[1],
                initialValue: decl[3].trim(),
                declaration: { file: file.path, row: row },
                usages: []
            };
        });
    });

    // Pass 2: Usages
    files.forEach(file => {
        var flows = [];
        flowsByFile[file.path] = flows;
        scanFileUsages(file, variables, flows);
    });

    return {
        variables: variables,
        flowsByFile: flowsByFile
    };
}

function scanFileUsages(file, variables, flows) {
    var lines = stripComments(file.text);
    var rawLines = file.text.split(/\r?\n/);

    var knot = null;
    var stitch = null;
    var isFunction = false;

    // Stack of multi-line { } blocks that are currently open, so that we know
    // whether "- something:" lines are conditions or just sequence content
    var blockStack = [];

    var currentFlow = () => ({
        knot: knot,
        stitch: stitch,
        isFunction: isFunction
    });

    flows.push({ row: 0, knot: null, stitch: null, isFunction: false });

    lines.forEach((line, row) => {

        var addCode = (code, isDeclaration) => {
            findVariableReferences(code).forEach(ref => {
                var variable = variables[ref.name];
                if( !variable ) return;
                if( isDeclaration && ref.name == isDeclaration ) return;

                // One entry per line: e.g. "~ x = x + 1" counts as a single set
                var last = variable.usages[variable.usages.length-1];
                if( last && last.file == file.path && last.row == row ) {
                    last.isWrite = last.isWrite || ref.isWrite;
                    return;
                }

                variable.usages.push({
                    file: file.path,
                    row: row,
                    flow: currentFlow(),
                    isWrite: ref.isWrite,
                    snippet: rawLines[row].trim()
                });
            });
        };

        // Knot / function header
        var knotMatch = line.match(/^\s*={2,}\s*(function\s+)?(\w+)\s*(\(([^)]*)\))?/);
        if( knotMatch ) {
            knot = knotMatch[2];
            stitch = null;
            isFunction = !!knotMatch[1];
            blockStack = [];
            flows.push({ row: row, knot: knot, stitch: null, isFunction: isFunction });
            return;
        }

        // Stitch header
        var stitchMatch = line.match(/^\s*=(?!=)\s*(\w+)/);
        if( stitchMatch ) {
            stitch = stitchMatch[1];
            blockStack = [];
            flows.push({ row: row, knot: knot, stitch: stitch, isFunction: isFunction });
            return;
        }

        // Global declarations: the initial value can reference other variables/constants
        var declMatch = line.match(/^\s*(VAR|CONST|LIST)\s+(\w+)\s*=\s*(.*)$/);
        if( declMatch ) {
            if( declMatch[1] != "LIST" ) addCode(declMatch[3], declMatch[2]);
            return;
        }

        if( /^\s*(INCLUDE|EXTERNAL)\b/.test(line) )
            return;

        // ~ logic line (optionally after gather/choice bullets)
        var logicMatch = line.match(/^\s*(?:[*+]\s*|-(?!>)\s*)*(?:\(\s*\w+\s*\)\s*)?~(.*)$/);
        if( logicMatch ) {
            addCode(logicMatch[1]);
            return;
        }

        var rest = line;

        // Branch inside a multi-line block: "- condition:"
        var currentBlock = blockStack[blockStack.length-1];
        if( currentBlock ) {
            var branchMatch = rest.match(/^\s*-(?!>)\s*([^:{}]+?)\s*:(?!:)(.*)$/);
            if( branchMatch ) {
                if( currentBlock == "conditional" && branchMatch[1].trim() != "else" )
                    addCode(branchMatch[1]);
                rest = branchMatch[2];
            }
        }

        scanMixedContent(rest, addCode, blockStack);
    });
}

// Prose, choices, gathers etc. Looks for {inline logic} and divert arguments.
function scanMixedContent(text, addCode, blockStack) {
    var i = 0;
    while( i < text.length ) {
        var c = text[i];

        if( c == "\\" ) {
            i += 2;
            continue;
        }

        if( c == "{" ) {
            var end = findMatchingBrace(text, i);

            // Unclosed brace: start of a multi-line block
            if( end == -1 ) {
                var header = text.substring(i+1);
                if( sequenceKeywordRegex.test(header) ) {
                    blockStack.push("sequence");
                } else {
                    var colonIdx = findTopLevel(header, ":");
                    if( colonIdx != -1 ) {
                        addCode(header.substring(0, colonIdx));
                        scanMixedContent(header.substring(colonIdx+1), addCode, blockStack);
                    }
                    blockStack.push("conditional");
                }
                return;
            }

            scanInlineLogic(text.substring(i+1, end), addCode, blockStack);
            i = end + 1;
            continue;
        }

        // Close of a multi-line block
        if( c == "}" ) {
            blockStack.pop();
            i++;
            continue;
        }

        // Divert with arguments: -> knot(x, y)
        if( c == "-" && text[i+1] == ">" ) {
            var divertMatch = text.substring(i).match(/^->\s*[\w.]+\s*\(/);
            if( divertMatch ) {
                var openIdx = i + divertMatch[0].length - 1;
                var closeIdx = findMatchingParen(text, openIdx);
                if( closeIdx != -1 ) {
                    addCode(text.substring(openIdx+1, closeIdx));
                    i = closeIdx + 1;
                    continue;
                }
            }
        }

        i++;
    }
}

// Content between { and } on a single line
function scanInlineLogic(content, addCode, blockStack) {

    // Sequence with type marker: {~a|b}, {&a|b}, {!a|b}, {$a|b}
    if( /^\s*[~&!$]/.test(content) && findTopLevel(content, "|") != -1 ) {
        scanMixedContent(content.replace(/^\s*[~&!$]/, ""), addCode, blockStack);
        return;
    }

    if( sequenceKeywordRegex.test(content) ) {
        scanMixedContent(content.replace(sequenceKeywordRegex, ""), addCode, blockStack);
        return;
    }

    // Conditional: {condition: a|b}
    var colonIdx = findTopLevel(content, ":");
    var pipeIdx = findTopLevel(content, "|");
    if( colonIdx != -1 && (pipeIdx == -1 || colonIdx < pipeIdx) ) {
        addCode(content.substring(0, colonIdx));
        scanMixedContent(content.substring(colonIdx+1), addCode, blockStack);
        return;
    }

    // Plain sequence: {a|b|c}
    if( pipeIdx != -1 ) {
        scanMixedContent(content, addCode, blockStack);
        return;
    }

    // Otherwise it's an expression to print: {x}, or a choice condition {x > 2}
    addCode(content);
}

function findVariableReferences(code) {
    // Blank out string literals so we don't match words inside them
    code = code.replace(/"[^"]*"/g, m => " ".repeat(m.length));

    var refs = [];
    var match;
    identifierRegex.lastIndex = 0;
    while( (match = identifierRegex.exec(code)) !== null ) {
        var name = match[0];
        var before = code[match.index-1];
        var after = code.substring(match.index + name.length);

        // Skip dotted paths (knot.stitch, List.item), function calls and numbers
        if( before == "." || /^\s*\.\w/.test(after) ) continue;
        if( /^\s*\(/.test(after) ) continue;
        if( before && /\w/.test(before) ) continue;

        refs.push({
            name: name,
            isWrite: writeOperatorRegex.test(after)
        });
    }
    return refs;
}

function findMatchingBrace(text, openIdx) {
    var depth = 0;
    for(var i=openIdx; i<text.length; i++) {
        if( text[i] == "\\" ) { i++; continue; }
        if( text[i] == "{" ) depth++;
        else if( text[i] == "}" ) {
            depth--;
            if( depth == 0 ) return i;
        }
    }
    return -1;
}

function findMatchingParen(text, openIdx) {
    var depth = 0;
    for(var i=openIdx; i<text.length; i++) {
        if( text[i] == "(" ) depth++;
        else if( text[i] == ")" ) {
            depth--;
            if( depth == 0 ) return i;
        }
    }
    return -1;
}

// Index of a character that isn't nested inside {}, () or "strings"
function findTopLevel(text, char) {
    var depth = 0;
    var inString = false;
    for(var i=0; i<text.length; i++) {
        var c = text[i];
        if( c == "\\" ) { i++; continue; }
        if( c == '"' ) inString = !inString;
        if( inString ) continue;
        if( c == "{" || c == "(" ) depth++;
        else if( c == "}" || c == ")" ) depth--;
        else if( c == char && depth == 0 ) {
            // "::" isn't a conditional separator
            if( char == ":" && (text[i+1] == ":" || text[i-1] == ":") ) continue;
            return i;
        }
    }
    return -1;
}

// Returns an array of lines with comments blanked out, preserving line count
function stripComments(text) {
    var lines = text.split(/\r?\n/);
    var inBlockComment = false;
    return lines.map(line => {
        var out = "";
        var i = 0;
        while( i < line.length ) {
            if( inBlockComment ) {
                var endIdx = line.indexOf("*/", i);
                if( endIdx == -1 ) { i = line.length; break; }
                inBlockComment = false;
                i = endIdx + 2;
                continue;
            }
            var c = line[i];
            if( c == "\\" ) { out += line.substr(i, 2); i += 2; continue; }
            if( c == "/" && line[i+1] == "/" ) break;
            if( c == "/" && line[i+1] == "*" ) { inBlockComment = true; i += 2; continue; }
            out += c;
            i++;
        }
        return out;
    });
}

// Which knot/stitch is a given row in?
function flowAtRow(flows, row) {
    if( !flows ) return null;
    var result = null;
    for(var i=0; i<flows.length; i++) {
        if( flows[i].row > row ) break;
        result = flows[i];
    }
    return result;
}

function flowName(flow) {
    if( !flow || !flow.knot ) return null;
    return flow.stitch ? `${flow.knot}.${flow.stitch}` : flow.knot;
}

exports.VariableIndex = {
    scanProject: scanProject,
    flowAtRow: flowAtRow,
    flowName: flowName
};
