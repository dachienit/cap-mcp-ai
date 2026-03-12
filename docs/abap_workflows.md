# ABAP Workflow Guide — MCP ADT Manager AI Assistant

Step-by-step workflows for common ABAP development tasks.

---

## Workflow 1: Create a new ABAP Class (Full 8-Step)

**Example user request:** *"Create class ZCL_PO_TEST in package ZPK_PACKAGE_MCP that prints Hello World"*

### Step 1 — Find the package to get parentPath
```json
{"tool_call": "search_package", "params": {"query": "ZPK_PACKAGE_MCP"}}
```
Extract the `url` field from the result (e.g. `/sap/bc/adt/packages/zpk_package_mcp`)

---

### Step 2 — Create the class object
```json
{
  "tool_call": "create_object",
  "params": {
    "objectType": "CLAS/OC",
    "name": "ZCL_PO_TEST",
    "packageName": "ZPK_PACKAGE_MCP",
    "description": "PO Test class",
    "parentPath": "/sap/bc/adt/packages/zpk_package_mcp",
    "transport": ""
  }
}
```
Extract `objectUrl` from the response.

---

### Step 3 — Verify the class was created (search again)
```json
{"tool_call": "search_object", "params": {"query": "ZCL_PO_TEST", "objectType": "CLAS"}}
```
Confirm the class exists and get its precise ADT URL.

---

### Step 4 — Lock the class for editing
```json
{"tool_call": "lock", "params": {"objectUrl": "/sap/bc/adt/oo/classes/zcl_po_test"}}
```
**Save:** `lockHandle`, `sessionCookie`, `csrfToken` — required for all subsequent steps.

---

### Step 5 — Upload source code (main include)
```json
{
  "tool_call": "set_source",
  "params": {
    "objectUrl": "/sap/bc/adt/oo/classes/zcl_po_test",
    "sourceUrl": "/sap/bc/adt/oo/classes/zcl_po_test/source/main",
    "source": "CLASS zcl_po_test DEFINITION\n  PUBLIC\n  FINAL\n  CREATE PUBLIC.\n\n  PUBLIC SECTION.\n    METHODS: run.\nENDCLASS.\n\nCLASS zcl_po_test IMPLEMENTATION.\n  METHOD run.\n    WRITE: / 'Hello World'.\n  ENDMETHOD.\nENDCLASS.",
    "lockHandle": "<from step 4>",
    "sessionCookie": "<from step 4>",
    "lockCsrfToken": "<from step 4>",
    "transport": ""
  }
}
```

---

### Step 6 — Unlock the class
```json
{
  "tool_call": "unlock",
  "params": {
    "objectUrl": "/sap/bc/adt/oo/classes/zcl_po_test",
    "lockHandle": "<from step 4>",
    "sessionCookie": "<from step 4>",
    "lockCsrfToken": "<from step 4>"
  }
}
```

---

### Step 7 — Activate the class
```json
{
  "tool_call": "activate",
  "params": {
    "objects": [{
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_po_test",
      "adtcore:type": "CLAS/OC",
      "adtcore:name": "ZCL_PO_TEST",
      "adtcore:parentUri": "/sap/bc/adt/packages/zpk_package_mcp"
    }]
  }
}
```

---

### Step 8 — (Optional) Create test include
Lock the class again first (new lock = new lockHandle), then:
```json
{
  "tool_call": "create_test_include",
  "params": {
    "clas": "ZCL_PO_TEST",
    "lockHandle": "<new lockHandle>",
    "sessionCookie": "<new sessionCookie>",
    "lockCsrfToken": "<new csrfToken>",
    "transport": ""
  }
}
```

---

## Workflow 2: Read and Modify Existing Object Source Code

**Example:** *"Read source of ZCL_MCP and add a method that calculates the sum of two numbers"*

### Step 1 — Find the object
```json
{"tool_call": "search_object", "params": {"query": "ZCL_MCP", "objectType": "CLAS"}}
```

### Step 2 — Read the current source code
```json
{"tool_call": "get_source", "params": {"objectUrl": "/sap/bc/adt/oo/classes/zcl_mcp"}}
```
Analyze the current code and plan the modifications.

### Step 3 — Lock → Set source (with modified code) → Unlock → Activate
Follow Steps 4–7 from Workflow 1.

---

## Workflow 3: Search and Display Object Information

**Example:** *"Find all classes starting with ZCL_IYH in package ZPK"*

### Step 1 — Search
```json
{"tool_call": "search_object", "params": {"query": "ZCL_*", "objectType": "CLAS", "maxResults": 50}}
```

### Step 2 — Present results as a table
```
| Name              | Type | Description    | Package          |
|-------------------|------|----------------|------------------|
| ZCL_MCP   | CLAS | MCP test class  | ZPK_PACKAGE_MCP  |
```

---

## Workflow 4: Create an ABAP Program (Report)

**Example:** *"Create report Z_HELLO_WORLD in package ZPK_PACKAGE"*

- `objectType`: `PROG`
- ADT URI prefix: `/sap/bc/adt/programs/programs/`

```json
{
  "tool_call": "create_object",
  "params": {
    "objectType": "PROG",
    "name": "Z_HELLO_WORLD",
    "packageName": "ZPK_PACKAGE",
    "description": "Hello World report",
    "parentPath": "/sap/bc/adt/packages/zpk_package"
  }
}
```

Source template for PROG:
```abap
REPORT z_hello_world.

START-OF-SELECTION.
  WRITE: / 'Hello World'.
```

---

## Workflow 5: Create an ABAP Interface

- `objectType`: `INTF`
- ADT URI prefix: `/sap/bc/adt/oo/interfaces/`

Source template:
```abap
INTERFACE zif_my_interface PUBLIC.
  METHODS:
    execute
      RETURNING VALUE(rv_result) TYPE string.
ENDINTERFACE.
```

---

## Object Type Quick Reference

| Object Type | objectType param | ADT URI prefix | Source URL suffix |
|---|---|---|---|
| Class | `CLAS/OC` | `/sap/bc/adt/oo/classes/` | `/source/main` |
| Program / Report | `PROG` | `/sap/bc/adt/programs/programs/` | `/source/main` |
| Interface | `INTF` | `/sap/bc/adt/oo/interfaces/` | `/source/main` |
| Function Group | `FUGR` | `/sap/bc/adt/functions/groups/` | `/source/main` |
| Package | `DEVC` | `/sap/bc/adt/packages/` | N/A |

---

## Error Handling Reference

| HTTP Code | Error Message | Root Cause | Resolution |
|---|---|---|---|
| `423` | `invalid lock handle` | set_source uses wrong ABAP session | Use `sessionCookie` from lock RESPONSE, not from CSRF fetch |
| `403` | `CSRF token validation failed` | Token/session mismatch | Re-fetch CSRF token and retry lock |
| `400` | `Wrong input data for processing` | Malformed XML payload | Check objectType and XML structure |
| `404` | `Not found` | Incorrect object URL | Search again to get accurate URL |
| `423` | `Object already locked` | Another session holds the lock | If own session: unlock first. Otherwise: inform user |
