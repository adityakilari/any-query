--
-- PostgreSQL database dump (schema only)
-- pg_dump --schema-only --no-owner --no-privileges shop
--

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SELECT pg_catalog.set_config('search_path', '', false);

CREATE TYPE public.order_status AS ENUM (
    'pending',
    'paid',
    'shipped',
    'delivered',
    'cancelled',
    'refunded'
);

CREATE TABLE public.customers (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    phone character varying(30),
    date_of_birth date,
    password character varying(255),
    marketing_opt_in boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

COMMENT ON TABLE public.customers IS 'People who have created an account in the web shop.';
COMMENT ON COLUMN public.customers.marketing_opt_in IS 'Consent to receive marketing email (GDPR).';

CREATE TABLE public.addresses (
    id bigint NOT NULL,
    customer_id bigint NOT NULL,
    label character varying(50),
    street character varying(255) NOT NULL,
    city character varying(100) NOT NULL,
    postal_code character varying(20),
    country_code character(2) NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);

CREATE TABLE public.categories (
    id integer NOT NULL,
    parent_id integer,
    name character varying(100) NOT NULL,
    slug character varying(120) NOT NULL
);

CREATE TABLE public.products (
    id bigint NOT NULL,
    category_id integer,
    sku character varying(64) NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    price double precision NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    stock_quantity integer DEFAULT 0 NOT NULL,
    attributes jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

COMMENT ON COLUMN public.products.price IS 'Unit price in the product currency.';

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id bigint NOT NULL,
    shipping_address_id bigint,
    status public.order_status DEFAULT 'pending'::public.order_status NOT NULL,
    subtotal numeric(12,2) NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    shipped_at timestamp with time zone,
    notes text
);

COMMENT ON TABLE public.orders IS 'A checkout by a customer. Totals are snapshotted at purchase time.';

CREATE TABLE public.order_items (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    product_id bigint NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0))
);

CREATE TABLE public.payments (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    provider character varying(30) NOT NULL,
    provider_reference character varying(100),
    amount numeric(12,2) NOT NULL,
    status character varying(20) NOT NULL,
    card_last4 character(4),
    paid_at timestamp with time zone
);

CREATE TABLE public.reviews (
    id bigint NOT NULL,
    product_id bigint NOT NULL,
    customer_id bigint,
    rating smallint NOT NULL,
    body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

CREATE TABLE public.product_tags (
    product_id bigint NOT NULL,
    tag_id integer NOT NULL
);

CREATE TABLE public.tags (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);

CREATE TABLE public.audit_log (
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id bigint,
    entity character varying(50) NOT NULL,
    entity_id bigint NOT NULL,
    action character varying(20) NOT NULL,
    changes jsonb
);

CREATE VIEW public.customer_order_totals AS
 SELECT c.id AS customer_id,
    c.email,
    count(o.id) AS order_count,
    COALESCE(sum(o.total), (0)::numeric) AS lifetime_value
   FROM (public.customers c
     LEFT JOIN public.orders o ON ((o.customer_id = c.id)))
  GROUP BY c.id, c.email;

CREATE SEQUENCE public.customers_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;
CREATE SEQUENCE public.orders_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;
CREATE SEQUENCE public.order_items_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;
CREATE SEQUENCE public.products_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);
ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);
ALTER TABLE ONLY public.order_items ALTER COLUMN id SET DEFAULT nextval('public.order_items_id_seq'::regclass);
ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);

ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customers ADD CONSTRAINT customers_email_key UNIQUE (email);
ALTER TABLE ONLY public.addresses ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.categories ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.categories ADD CONSTRAINT categories_slug_key UNIQUE (slug);
ALTER TABLE ONLY public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.products ADD CONSTRAINT products_sku_key UNIQUE (sku);
ALTER TABLE ONLY public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.product_tags ADD CONSTRAINT product_tags_pkey PRIMARY KEY (product_id, tag_id);
ALTER TABLE ONLY public.tags ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);
CREATE INDEX order_items_order_id_idx ON public.order_items USING btree (order_id);
CREATE INDEX audit_log_entity_idx ON public.audit_log USING btree (entity, entity_id);

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id);
ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shipping_address_id_fkey FOREIGN KEY (shipping_address_id) REFERENCES public.addresses(id);
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);
ALTER TABLE ONLY public.product_tags
    ADD CONSTRAINT product_tags_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.product_tags
    ADD CONSTRAINT product_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;
