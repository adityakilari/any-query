-- Imports documents from a JSON payload (PostgreSQL PL/pgSQL function).
-- Open the Review tab: a variable that is never set, an UPDATE that changes nothing,
-- an UPDATE that repeats on every pass of the loop, and a count-then-insert race.
CREATE OR REPLACE FUNCTION docs.import_documents(p_payload text)
 RETURNS SETOF docs.documents
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_items     json;
  v_item      json;
  v_doc_key   varchar;
  v_file_name varchar;
  v_url       varchar;
  v_folder    varchar;
  v_category  varchar;
  v_type_id   bigint;
  v_parent_id bigint;
  v_exists    integer;
  v_unused    varchar;
  v_new_keys  text[] := ARRAY[]::text[];
BEGIN
  v_items := (p_payload::json)->'items';
  IF json_typeof(v_items) <> 'array' THEN
    v_items := json_build_array(v_items);
  END IF;

  FOR v_item IN SELECT * FROM json_array_elements(v_items)
  LOOP
    v_doc_key   := v_item->>'id';
    v_file_name := v_item->>'file_name';
    v_url       := v_item->>'url';
    v_folder    := SUBSTRING(v_url, 1, POSITION('/' IN v_url) - 1);
    v_category  := COALESCE(v_item->>'category', 'Other');

    IF v_category IS NOT NULL THEN
      SELECT t.id INTO v_type_id
      FROM docs.document_types t
      JOIN docs.categories c ON c.id = t.category_id
      WHERE LOWER(c.name) = LOWER(v_category);
    END IF;

    SELECT COUNT(*) INTO v_exists FROM docs.documents WHERE external_key = v_doc_key;

    IF v_exists = 0 THEN
      INSERT INTO docs.documents (external_key, file_name, url, folder, type_id, created_at)
      VALUES (v_doc_key, v_file_name, v_url, v_folder, v_type_id, now());
      v_new_keys := array_append(v_new_keys, v_doc_key);
    END IF;

    UPDATE docs.documents SET url = '' || url WHERE external_key = v_doc_key;

    UPDATE docs.documents d SET type_id = t.id
    FROM docs.document_types t
    WHERE t.name = d.folder
      AND t.category_id = v_parent_id
      AND d.external_key = v_doc_key
      AND d.type_id IS NULL;

    UPDATE docs.documents SET is_active = false WHERE folder = 'archive';
  END LOOP;

  RETURN QUERY SELECT d.* FROM docs.documents d WHERE d.external_key = ANY(v_new_keys);
END;
$function$;
