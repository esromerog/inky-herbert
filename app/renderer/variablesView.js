const $ = window.jQuery = require('./jquery-2.2.3.min.js');
const _ = require("lodash");
const i18n = require("./i18n.js");
const VariableIndex = require("./variableIndex.js").VariableIndex;

// Separator used to evaluate every variable in a single expression
// (avoids one round trip to inklecate per variable each turn)
const liveValueSeparator = "%%%";

var $wrapper = null;
var $list = null;
var $search = null;
var $onlyCurrent = null;
var $currentFlowLabel = null;

var events = {};

var index = null;
var refreshTimeout = null;
var expandedNames = new Set();

var cursorFile = null;
var cursorRow = 0;

var liveValues = {};
var previousLiveValues = null;
var liveValueNames = [];

// i18n lookups are synchronous IPC calls, so do them once up front
var str = {};

$(document).ready(() => {
    str = {
        variables:   i18n._("Variables"),
        lists:       i18n._("Lists"),
        constants:   i18n._("Constants"),
        emptyTitle:  i18n._("Variables"),
        emptyDesc:   i18n._("Variables declared with VAR, CONST and LIST are tracked here, along with every knot that reads or sets them"),
        noMatches:   i18n._("No matching variables"),
        declared:    i18n._("declared"),
        set:         i18n._("set"),
        read:        i18n._("read"),
        unused:      i18n._("unused"),
        neverRead:   i18n._("never read"),
        neverSet:    i18n._("never changed"),
        topOfFile:   i18n._("top of"),
        knot:        i18n._("knot"),
        knots:       i18n._("knots"),
        topLevel:    i18n._("top level"),
        empty:       i18n._("(empty)"),
        liveTooltip: i18n._("Value at the current point in the playthrough")
    };

    $wrapper = $("#variables-wrapper");
    $list = $wrapper.find(".var-list");
    $search = $wrapper.find(".var-search");
    $onlyCurrent = $wrapper.find(".var-only-current input");
    $currentFlowLabel = $wrapper.find(".var-current-flow");

    $search.on("input", render);
    $onlyCurrent.on("change", render);

    $wrapper.on("click", ".var-row", function(event) {
        event.preventDefault();
        var name = $(this).closest(".var-item").attr("data-name");
        if( expandedNames.has(name) ) expandedNames.delete(name);
        else                          expandedNames.add(name);
        $(this).closest(".var-item").toggleClass("expanded", expandedNames.has(name));
    });

    $wrapper.on("click", ".var-usage", function(event) {
        event.preventDefault();
        var $usage = $(this);
        events.jumpTo($usage.attr("data-file"), parseInt($usage.attr("data-row")));
    });

    render();
});

// Rescanning is cheap but there's no need to do it on every keystroke
function scheduleRefresh(project) {
    if( refreshTimeout ) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(() => {
        refreshTimeout = null;
        refresh(project);
    }, 300);
}

function refresh(project) {
    if( !project ) return;

    // Spare files aren't part of the story, so their variables don't really exist
    var files = project.files
        .filter(f => !f.isSpare)
        .map(f => ({ path: f.relativePath(), text: f.getValue() }));

    index = VariableIndex.scanProject(files);
    render();
}

function setCursor(filePath, row) {
    var changed = filePath != cursorFile || row != cursorRow;
    cursorFile = filePath;
    cursorRow = row;
    if( !changed || !index ) return;

    var flow = currentFlow();
    var flowKey = flowKeyOf(flow, cursorFile);
    if( flowKey == $wrapper.attr("data-current-flow") ) return;

    // Only need a full re-render when filtering by the current knot
    if( $onlyCurrent.is(":checked") ) render();
    else updateCurrentFlowHighlights();
}

function currentFlow() {
    if( !index || !cursorFile ) return null;
    return VariableIndex.flowAtRow(index.flowsByFile[cursorFile], cursorRow);
}

// Knot names are unique across the project, but top level content
// before the first knot is distinguished per file
function flowKeyOf(flow, file) {
    if( !flow ) return "";
    return flow.knot ? flow.knot : `top:${file}`;
}

function isUsedInFlow(variable, flowKey) {
    return variable.usages.some(u => flowKeyOf(u.flow, u.file) == flowKey);
}

function updateCurrentFlowHighlights() {
    var flow = currentFlow();
    var flowKey = flowKeyOf(flow, cursorFile);
    $wrapper.attr("data-current-flow", flowKey);
    $currentFlowLabel.text(flow && flow.knot ? flow.knot : `${str.topOfFile} ${cursorFile || ""}`);

    if( !index ) return;
    $list.find(".var-item").each((i, el) => {
        var variable = index.variables[$(el).attr("data-name")];
        $(el).toggleClass("in-current-flow", !!variable && isUsedInFlow(variable, flowKey));
    });
}

function render() {
    if( !$list ) return;

    var scrollTop = $wrapper.scrollTop();
    $list.empty();

    var allVariables = index ? _.values(index.variables) : [];
    if( allVariables.length == 0 ) {
        $list.append(`<nav class="nav-group"><h5 class="nav-group-title">${str.emptyTitle}</h5></nav>
            <nav class="nav-group"><span class="nav-group-item nav-tooltip">${str.emptyDesc}</span></nav>`);
        updateCurrentFlowHighlights();
        return;
    }

    var flowKey = flowKeyOf(currentFlow(), cursorFile);
    var searchText = ($search.val() || "").trim().toLowerCase();
    var onlyCurrent = $onlyCurrent.is(":checked");

    var visible = allVariables.filter(v => {
        if( searchText && v.name.toLowerCase().indexOf(searchText) == -1 ) return false;
        if( onlyCurrent && !isUsedInFlow(v, flowKey) ) return false;
        return true;
    });

    if( visible.length == 0 ) {
        $list.append(`<nav class="nav-group"><span class="nav-group-item nav-tooltip">${str.noMatches}</span></nav>`);
        updateCurrentFlowHighlights();
        return;
    }

    var groups = [
        { title: str.variables, kind: "VAR"   },
        { title: str.lists,     kind: "LIST"  },
        { title: str.constants, kind: "CONST" }
    ];

    groups.forEach(group => {
        var groupVars = _.sortBy(visible.filter(v => v.kind == group.kind), v => v.name.toLowerCase());
        if( groupVars.length == 0 ) return;

        var $group = $(`<nav class="nav-group"><h5 class="nav-group-title">${group.title} (${groupVars.length})</h5></nav>`);
        groupVars.forEach(v => $group.append(renderVariable(v)));
        $list.append($group);
    });

    updateCurrentFlowHighlights();
    $wrapper.scrollTop(scrollTop);
}

function renderVariable(variable) {
    var writes = variable.usages.filter(u => u.isWrite).length;
    var reads = variable.usages.length - writes;
    var knotCount = _.uniq(variable.usages.map(u => flowKeyOf(u.flow, u.file))).length;

    var summary;
    var warningClass = "";
    if( variable.usages.length == 0 ) {
        summary = str.unused;
        warningClass = "unused";
    } else {
        var parts = [];
        if( writes > 0 ) parts.push(`${str.set} ${writes}`);
        if( reads > 0 )  parts.push(`${str.read} ${reads}`);
        parts.push(`${knotCount} ${knotCount == 1 ? str.knot : str.knots}`);
        summary = parts.join(" · ");

        if( reads == 0 ) {
            summary += ` · ${str.neverRead}`;
            warningClass = "never-read";
        } else if( writes == 0 && variable.kind == "VAR" ) {
            summary += ` · ${str.neverSet}`;
        }
    }

    var expandedClass = expandedNames.has(variable.name) ? "expanded" : "";

    var $item = $(`<div class="var-item ${expandedClass} ${warningClass}" data-name="${escapeHtml(variable.name)}">
        <span class="nav-group-item var-row">
            <span class="var-disclosure icon icon-right-dir"></span>
            <span class="var-name filename">${escapeHtml(variable.name)}</span>
            <span class="var-value" title="${str.liveTooltip}"></span>
            <span class="var-summary">${summary}</span>
        </span>
        <div class="var-details"></div>
    </div>`);

    setValueText($item.find(".var-value"), variable.name);

    var $details = $item.find(".var-details");
    var decl = variable.declaration;
    $details.append(`<div class="var-usage declaration" data-file="${escapeHtml(decl.file)}" data-row="${decl.row}">
        <span class="var-badge">${str.declared}</span>
        <span class="var-snippet">= ${escapeHtml(variable.initialValue)}</span>
        <span class="var-location">${escapeHtml(decl.file)}:${decl.row+1}</span>
    </div>`);

    // Group usages by knot/stitch, in the order they appear in the source
    var byFlow = _.groupBy(variable.usages, u => `${u.file}|${VariableIndex.flowName(u.flow) || ""}`);
    _.forEach(byFlow, usages => {
        var first = usages[0];
        var name = VariableIndex.flowName(first.flow);
        var title = name ? name : `${str.topLevel} (${first.file})`;
        var funcClass = first.flow.isFunction ? "function" : "";
        $details.append(`<div class="var-flow ${funcClass}">${escapeHtml(title)}</div>`);

        usages.forEach(u => {
            $details.append(`<div class="var-usage ${u.isWrite ? "write" : "read"}" data-file="${escapeHtml(u.file)}" data-row="${u.row}" title="${escapeHtml(u.file)}:${u.row+1}">
                <span class="var-badge">${u.isWrite ? str.set : str.read}</span>
                <span class="var-snippet">${escapeHtml(u.snippet)}</span>
            </div>`);
        });
    });

    return $item;
}

function setValueText($value, name) {
    if( !(name in liveValues) ) {
        $value.text("");
        return;
    }
    var value = liveValues[name];
    $value.text(value === "" ? str.empty : value);
    $value.toggleClass("empty", value === "");
}

// --------------------------------------------------------
// Live values from the running story
// --------------------------------------------------------

// Builds an expression for inklecate that prints every variable at once
function liveValuesExpression() {
    if( !index ) return null;
    liveValueNames = _.keys(index.variables);
    if( liveValueNames.length == 0 ) return null;
    return liveValueNames.map(n => `{${n}}`).join(liveValueSeparator);
}

function setLiveValues(result, error) {
    if( error || result === null || result === undefined ) {
        // e.g. a variable that was just declared but hasn't compiled yet
        return;
    }

    var values = String(result).split(liveValueSeparator);
    if( values.length != liveValueNames.length ) return;

    var newValues = {};
    liveValueNames.forEach((name, i) => newValues[name] = values[i].trim());

    var changedNames = previousLiveValues ? liveValueNames.filter(n => n in previousLiveValues && previousLiveValues[n] !== newValues[n]) : [];

    liveValues = newValues;
    previousLiveValues = newValues;

    $list.find(".var-item").each((i, el) => {
        var name = $(el).attr("data-name");
        var $value = $(el).find(".var-value");
        setValueText($value, name);
        if( changedNames.indexOf(name) != -1 ) {
            // Restart the flash animation
            $value.removeClass("changed");
            void $value.get(0).offsetWidth;
            $value.addClass("changed");
        }
    });
}

// Called when the story restarts so that the first turn
// isn't compared against the end of the previous playthrough
function resetLiveValueBaseline() {
    previousLiveValues = null;
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

exports.VariablesView = {
    setEvents: e => events = e,
    scheduleRefresh: scheduleRefresh,
    setCursor: setCursor,
    liveValuesExpression: liveValuesExpression,
    setLiveValues: setLiveValues,
    resetLiveValueBaseline: resetLiveValueBaseline
};
