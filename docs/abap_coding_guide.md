# ABAP Coding Guide — MCP ADT Manager AI Assistant

Standards and best practices for generating ABAP source code. Follow these guidelines when writing or modifying ABAP code for the SAP on-premise system.

---

## 1. General Naming Conventions

All custom objects must use the **Z or Y namespace prefix**.

| Object Type | Pattern | Example |
|---|---|---|
| Class | `ZCL_<NAME>` | `ZCL_PO_HANDLER` |
| Interface | `ZIF_<NAME>` | `ZIF_PROCESSABLE` |
| Global Type | `ZTY_<NAME>` | (defined in class) |
| Report / Program | `Z_<NAME>` or `Z_<PREFIX>_<NAME>` | `Z_MRP_REPORT` |
| Function Group | `Z<NAME>` (max 26 chars) | `ZMRP_FUNCTIONS` |
| Enhancement Spot | `ZES_<NAME>` | `ZES_ORDER_CHECK` |

**Rules:**
- Always UPPERCASE for object names
- Use underscores as word separators
- Maximum 30 characters for most object types
- Avoid generic names like `ZTEST` or `ZTMP` in production packages

---

## 2. ABAP Class Template (CLAS/OC)

### Basic Class Structure
```abap
CLASS zcl_my_class DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    METHODS:
      constructor,
      run
        RETURNING VALUE(rv_result) TYPE string.

  PROTECTED SECTION.

  PRIVATE SECTION.
    DATA: mv_value TYPE string.

ENDCLASS.

CLASS zcl_my_class IMPLEMENTATION.

  METHOD constructor.
    mv_value = 'initialized'.
  ENDMETHOD.

  METHOD run.
    rv_result = mv_value.
  ENDMETHOD.

ENDCLASS.
```

### Class with Exception
```abap
CLASS zcl_order_handler DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    METHODS:
      process_order
        IMPORTING iv_order_id TYPE vbeln
        RETURNING VALUE(rv_status) TYPE string
        RAISING   zcx_order_error.

ENDCLASS.

CLASS zcl_order_handler IMPLEMENTATION.

  METHOD process_order.
    IF iv_order_id IS INITIAL.
      RAISE EXCEPTION TYPE zcx_order_error
        MESSAGE e001(zorder_msg).
    ENDIF.
    rv_status = 'PROCESSED'.
  ENDMETHOD.

ENDCLASS.
```

---

## 3. ABAP Report / Program Template (PROG)

```abap
REPORT z_my_report.

* Type definitions
TYPES: BEGIN OF ty_item,
         matnr TYPE matnr,
         maktx TYPE maktx,
       END OF ty_item.

* Global data
DATA: lt_items TYPE STANDARD TABLE OF ty_item,
      ls_item  TYPE ty_item.

* Selection screen
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-001.
  SELECT-OPTIONS so_matnr FOR ls_item-matnr.
SELECTION-SCREEN END OF BLOCK b1.

* Main processing
START-OF-SELECTION.
  PERFORM get_data.
  PERFORM display_data.

*&---------------------------------------------------------------------*
*& Form get_data
*&---------------------------------------------------------------------*
FORM get_data.
  SELECT matnr maktx
    FROM mara
    INNER JOIN makt ON mara~matnr = makt~matnr
    WHERE mara~matnr IN so_matnr
      AND makt~spras = sy-langu
    INTO TABLE lt_items.
ENDFORM.

*&---------------------------------------------------------------------*
*& Form display_data
*&---------------------------------------------------------------------*
FORM display_data.
  LOOP AT lt_items INTO ls_item.
    WRITE: / ls_item-matnr, ls_item-maktx.
  ENDLOOP.
ENDFORM.
```

---

## 4. ABAP Interface Template (INTF)

```abap
INTERFACE zif_processable PUBLIC.

  METHODS:
    process
      IMPORTING iv_input  TYPE string
      RETURNING VALUE(rv_result) TYPE string,

    validate
      IMPORTING iv_data   TYPE string
      RETURNING VALUE(rv_valid) TYPE abap_bool.

ENDINTERFACE.
```

---

## 5. Modern ABAP Syntax (ABAP 7.40+)

Use modern syntax whenever possible:

### Inline Declarations
```abap
" Old style
DATA lv_result TYPE string.
lv_result = 'Hello'.

" New style (ABAP 7.40+)
DATA(lv_result) = 'Hello'.
```

### String Templates
```abap
DATA(lv_message) = |Order { iv_order_id } processed successfully|.
```

### LOOP AT with GROUP BY
```abap
LOOP AT lt_items ASSIGNING FIELD-SYMBOL(<ls_item>).
  <ls_item>-status = 'ACTIVE'.
ENDLOOP.
```

### Table Operations
```abap
" Filter table
DATA(lt_active) = FILTER #( lt_items USING KEY primary_key
                             WHERE status = 'ACTIVE' ).

" Value constructor
DATA(ls_new_item) = VALUE ty_item( matnr = '000001'
                                   maktx = 'Test Material' ).
```

### Conditional Assignment
```abap
DATA(lv_text) = COND string( WHEN lv_flag = abap_true
                              THEN 'Active'
                              ELSE 'Inactive' ).
```

---

## 6. OData / BTP Integration Patterns

### Calling OData from ABAP
```abap
DATA(lo_http_client) = cl_http_client=>create_by_destination(
  i_destination = 'MY_BTP_DEST' ).

lo_http_client->request->set_method( 'GET' ).
lo_http_client->request->set_header_field(
  name  = 'Accept'
  value = 'application/json' ).

lo_http_client->send( EXCEPTIONS OTHERS = 1 ).
lo_http_client->receive( EXCEPTIONS OTHERS = 1 ).

DATA(lv_response) = lo_http_client->response->get_cdata( ).
```

---

## 7. Unit Test Template (ABAP Unit)

```abap
CLASS ltcl_test DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    DATA: mo_cut TYPE REF TO zcl_my_class.  "CUT = Class Under Test"

    METHODS:
      setup,
      test_run FOR TESTING.
ENDCLASS.

CLASS ltcl_test IMPLEMENTATION.

  METHOD setup.
    mo_cut = NEW zcl_my_class( ).
  ENDMETHOD.

  METHOD test_run.
    DATA(lv_result) = mo_cut->run( ).
    cl_abap_unit_assert=>assert_equals(
      act = lv_result
      exp = 'expected_value'
      msg = 'run() should return expected_value' ).
  ENDMETHOD.

ENDCLASS.
```

---

## 8. Error Handling Best Practices

```abap
" Always use class-based exceptions
TRY.
    DATA(lv_result) = lo_handler->process( ).
  CATCH zcx_my_exception INTO DATA(lo_ex).
    WRITE: / lo_ex->get_text( ).
  CATCH cx_root INTO DATA(lo_root).
    WRITE: / lo_root->get_text( ).
ENDTRY.
```

**Never use:**
- `RAISE` without proper exception class
- `MESSAGE ... TYPE 'A'` in methods (terminates entire program)
- `CATCH cx_root` without re-raising in production code

---

## 9. Performance Best Practices

- **Use SELECT...INTO TABLE** instead of SELECT SINGLE in loops
- **Avoid SELECT DISTINCT** — use SORT + DELETE ADJACENT DUPLICATES instead
- **Use secondary keys** on large internal tables accessed frequently by non-primary fields
- **Prefer FIELD-SYMBOL** over `INTO ls_item` in loops to avoid copying
- **Use buffered table reads** with `FOR ALL ENTRIES` carefully (check non-empty source table first)

---

## 10. Documentation Standards

Every class, method, and form should have a short comment header:
```abap
"! <p class="shorttext synchronized" lang="en">Order Processing Handler</p>
CLASS zcl_order_handler DEFINITION PUBLIC FINAL CREATE PUBLIC.
```

```abap
"! Process a sales order
"! @parameter iv_vbeln | Sales order number
"! @parameter rv_status | Processing status
METHOD process_order.
```
