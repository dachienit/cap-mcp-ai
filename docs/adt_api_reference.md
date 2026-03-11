# ADT REST API Reference — MCP ADT Manager

Reference documentation for all ADT (ABAP Development Tools) REST API endpoints exposed by the MCP ADT Manager backend on SAP BTP.

## Base URL
```
https://robert-bosch-gmbh-rb-btphub-taf-d-bt222d00-cap-mcp-ai.cfapps.eu10-004.hana.ondemand.com
```

All API calls require a valid BTP session (XSUAA JWT). The BTP app forwards calls to the on-premise SAP system via BTP Destination `T4X_011` through Cloud Connector.

---

## POST /api/adt/search

Search ABAP repository objects by name pattern.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "query": "ZCL_IYH*",
  "objectType": "CLAS",
  "maxResults": 50
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `destinationName` | string | Yes | BTP Destination name |
| `query` | string | Yes | Name pattern with `*` wildcard |
| `objectType` | string | No | `PROG`, `CLAS`, `INTF`, `FUGR`, `DEVC`, or empty |
| `maxResults` | number | No | Default 50 |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "name": "ZCL_IYH1HC_MCP",
      "type": "CLAS/OC",
      "description": "MCP test class",
      "packageName": "ZPK_IYH1HC_MCP",
      "url": "/sap/bc/adt/oo/classes/zcl_iyh1hc_mcp"
    }
  ]
}
```

---

## POST /api/adt/search-package

Search ABAP packages (DEVC) by name pattern.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "query": "ZPK_IYH*",
  "maxResults": 20
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "name": "ZPK_IYH1HC_MCP",
      "description": "MCP test package",
      "superPackage": "ZLOCAL",
      "url": "/sap/bc/adt/packages/zpk_iyh1hc_mcp"
    }
  ]
}
```

---

## POST /api/adt/get-source

Retrieve the ABAP source code of an existing object.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "objectUrl": "/sap/bc/adt/oo/classes/zcl_iyh1hc_mcp"
}
```

**Response:**
```json
{
  "success": true,
  "source": "CLASS zcl_iyh1hc_mcp DEFINITION PUBLIC...",
  "sourceUrl": "/sap/bc/adt/oo/classes/zcl_iyh1hc_mcp/source/main"
}
```

---

## POST /api/adt/create-object

Create a new ABAP development object.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "objectType": "CLAS/OC",
  "name": "ZCL_MY_CLASS",
  "packageName": "ZPK_IYH1HC_MCP",
  "description": "My ABAP class",
  "responsible": "IYH1HC",
  "parentPath": "/sap/bc/adt/packages/zpk_iyh1hc_mcp",
  "transport": ""
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `objectType` | string | Yes | `CLAS/OC`, `PROG`, `INTF`, `FUGR`, `DEVC` |
| `name` | string | Yes | Object name (UPPERCASE) |
| `packageName` | string | Yes | Package name (UPPERCASE) |
| `description` | string | No | Short description |
| `responsible` | string | No | SAP user ID. Defaults to logged-in user |
| `parentPath` | string | Recommended | ADT URI of parent package from search_package |
| `transport` | string | No | TR number. Empty = auto-created by SAP |

**Response:**
```json
{
  "success": true,
  "objectUrl": "/sap/bc/adt/oo/classes/zcl_my_class",
  "statusCode": 201
}
```

---

## POST /api/adt/lock

Lock an ABAP object for exclusive editing. **Must be called before set-source.**

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "objectUrl": "/sap/bc/adt/oo/classes/zcl_my_class",
  "accessMode": "MODIFY"
}
```

**Response:**
```json
{
  "success": true,
  "lockHandle": "CA0F3716E8B44325E00B903DA77AFB09CCEF7617",
  "sessionCookie": "sap-usercontext=sap-client=011; MYSAPSSO2=...",
  "csrfToken": "lv8DWabl7y..."
}
```

> **Critical:** The `sessionCookie` is extracted from the LOCK RESPONSE headers (not from CSRF fetch). It represents the ABAP session that holds the lock. Pass it unchanged to `set-source` and `unlock`.

---

## POST /api/adt/set-source

Upload ABAP source code to a locked object.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "objectUrl": "/sap/bc/adt/oo/classes/zcl_my_class",
  "sourceUrl": "/sap/bc/adt/oo/classes/zcl_my_class/source/main",
  "source": "CLASS zcl_my_class DEFINITION PUBLIC...",
  "lockHandle": "CA0F3716E8B44325E00B903DA77AFB09CCEF7617",
  "sessionCookie": "<from lock response>",
  "lockCsrfToken": "<csrfToken from lock response>",
  "transport": ""
}
```

| Field | Required | Description |
|---|---|---|
| `sourceUrl` | Yes | For class main: `<objectUrl>/source/main`. For test: `<objectUrl>/includes/testclasses` |
| `lockHandle` | Yes | From lock endpoint |
| `sessionCookie` | Yes | From lock endpoint — same ABAP session |
| `lockCsrfToken` | Yes | From lock endpoint |
| `transport` | No | TR number |

**Response:**
```json
{
  "success": true,
  "message": "Source saved successfully",
  "sourceUrl": "/sap/bc/adt/oo/classes/zcl_my_class/source/main"
}
```

**Error 423:** "invalid lock handle" → sessionCookie from wrong session. Ensure using cookie from lock RESPONSE.

---

## POST /api/adt/unlock

Release the lock on an ABAP object.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "objectUrl": "/sap/bc/adt/oo/classes/zcl_my_class",
  "lockHandle": "CA0F3716E8B44325E00B903DA77AFB09CCEF7617",
  "sessionCookie": "<from lock response>",
  "lockCsrfToken": "<csrfToken from lock response>"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Object unlocked"
}
```

---

## POST /api/adt/activate

Activate one or more ABAP objects. Supports both simple and MCP_ABAP input formats.

**Request Body (MCP_ABAP format):**
```json
{
  "destinationName": "T4X_011",
  "objects": [
    {
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_my_class",
      "adtcore:type": "CLAS/OC",
      "adtcore:name": "ZCL_MY_CLASS",
      "adtcore:parentUri": "/sap/bc/adt/packages/zpk_iyh1hc_mcp"
    }
  ]
}
```

**Request Body (Simple format — also supported):**
```json
{
  "destinationName": "T4X_011",
  "objects": [
    {
      "url": "/sap/bc/adt/oo/classes/zcl_my_class",
      "type": "CLAS/OC",
      "name": "ZCL_MY_CLASS",
      "parentUri": "/sap/bc/adt/packages/zpk_iyh1hc_mcp"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "status": 200,
  "message": "Activated successfully"
}
```

---

## POST /api/adt/create-test-include

Create the test class include (CLAS/OCX) for an existing ABAP class. The class must be locked before calling this endpoint.

**Request Body:**
```json
{
  "destinationName": "T4X_011",
  "clas": "ZCL_MY_CLASS",
  "lockHandle": "CA0F3716E8B44325E00B903DA77AFB09CCEF7617",
  "sessionCookie": "<from lock response>",
  "lockCsrfToken": "<csrfToken from lock response>",
  "transport": ""
}
```

**Response:**
```json
{
  "success": true,
  "message": "Test include created for class ZCL_MY_CLASS"
}
```

---

## ADT URI Patterns Reference

| Object | ADT Base URI | Notes |
|---|---|---|
| Class | `/sap/bc/adt/oo/classes/<name>` | lowercase name |
| Class source | `/sap/bc/adt/oo/classes/<name>/source/main` | main include |
| Class test include | `/sap/bc/adt/oo/classes/<name>/includes/testclasses` | OCX |
| Program | `/sap/bc/adt/programs/programs/<name>` | lowercase |
| Interface | `/sap/bc/adt/oo/interfaces/<name>` | lowercase |
| Function Group | `/sap/bc/adt/functions/groups/<name>` | lowercase |
| Package | `/sap/bc/adt/packages/<name>` | lowercase |

---

## HTTP Status Codes

| Status | Meaning |
|---|---|
| `200` | Success |
| `201` | Object created |
| `400` | Bad request — malformed payload or unsupported objectType |
| `403` | CSRF validation failed — re-fetch token |
| `404` | Object not found — verify the objectUrl |
| `423` | Object locked or invalid lock handle — check session cookie |
| `500` | Backend error — check BTP/CC logs |
