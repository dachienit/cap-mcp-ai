/**
 * ToolCallBubble.jsx — Displays a single AI tool call with its status and result
 *
 * Shows: tool name, params summary, status icon (pending/success/error), result preview
 */

const TOOL_LABELS = {
    search_object:       'Search Object',
    search_package:      'Search Package',
    get_source:          'Get Source Code',
    create_object:       'Create Object',
    lock:                'Lock Object',
    set_source:          'Set Source Code',
    unlock:              'Unlock Object',
    activate:            'Activate Object',
    create_test_include: 'Create Test Include',
};

const TOOL_ICONS = {
    search_object:       '⌕',
    search_package:      '⌕',
    get_source:          '</>',
    create_object:       '+',
    lock:                '◉',
    set_source:          '↑',
    unlock:              '○',
    activate:            '▶',
    create_test_include: '⊕',
};

export default function ToolCallBubble({ toolCall }) {
    const { tool, params, status, result, textBefore } = toolCall;
    const label = TOOL_LABELS[tool] || tool;
    const icon  = TOOL_ICONS[tool] || '◆';

    // Build a short summary of the params for display
    const paramSummary = buildParamSummary(tool, params);

    // Parse result for display
    let resultSummary = '';
    if (result) {
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed.count !== undefined)    resultSummary = `${parsed.count} result(s)`;
            else if (parsed.objectUrl)         resultSummary = parsed.objectUrl;
            else if (parsed.lockHandle)        resultSummary = `Handle: ${parsed.lockHandle.substring(0, 12)}...`;
            else if (parsed.message)           resultSummary = parsed.message;
            else if (parsed.source)            resultSummary = `${(parsed.source || '').split('\n').length} lines`;
        } catch (_) {
            resultSummary = typeof result === 'string' ? result.substring(0, 60) : '';
        }
    }

    return (
        <div className={`tool-bubble tool-bubble--${status}`}>
            {/* Text before tool call (AI narration) */}
            {textBefore && <div className="tool-bubble-narration">{textBefore}</div>}

            <div className="tool-bubble-row">
                <span className="tool-bubble-icon">{icon}</span>
                <span className="tool-bubble-label">{label}</span>
                {paramSummary && <span className="tool-bubble-param">{paramSummary}</span>}
                <span className={`tool-bubble-status tool-bubble-status--${status}`}>
                    {status === 'success' ? '✓' : status === 'error' ? '✗' : '…'}
                </span>
                {resultSummary && (
                    <span className="tool-bubble-result">{resultSummary}</span>
                )}
            </div>
        </div>
    );
}

function buildParamSummary(tool, params) {
    if (!params) return '';
    switch (tool) {
        case 'search_object':
        case 'search_package':
            return `"${params.query || ''}"${params.objectType ? ` [${params.objectType}]` : ''}`;
        case 'get_source':
        case 'lock':
        case 'unlock':
            return (params.objectUrl || '').split('/').pop();
        case 'create_object':
            return `${params.name || ''} (${params.objectType || ''})`;
        case 'set_source':
            return (params.sourceUrl || params.objectUrl || '').split('/').pop();
        case 'activate':
            return (params.objects || []).map(o => o['adtcore:name'] || o.name || '').join(', ');
        case 'create_test_include':
            return params.clas || '';
        default:
            return '';
    }
}
