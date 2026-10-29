--
-- PostgreSQL database dump
--

\restrict NOdjE1NeAs4g17zfknNnA2t5rObXHMub0gSSRL6RrGkPahhFtjcNe9hA0e4BU3E

-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: bump_project_task_cache_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_project_task_cache_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.task_cache_version := OLD.task_cache_version + 1;
  RETURN NEW;
END;
$$;


--
-- Name: invalidate_project_tasks(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_project_tasks() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- NEW contains the task that was created.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = NEW.project_id;

  ELSIF TG_OP = 'DELETE' THEN
    -- OLD contains the task that was deleted.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = OLD.project_id;

  ELSE
    -- An update has both OLD and NEW values.
    -- If a task moves between projects, advance both versions.
    -- If it stays in the same project, that project advances once.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id IN (OLD.project_id, NEW.project_id);
  END IF;

  -- This AFTER trigger does not need to return a modified task.
  RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description character varying(255),
    status character varying(100),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    user_id integer,
    task_cache_version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT projects_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'pending'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id integer NOT NULL,
    title character varying(50) NOT NULL,
    project_id integer NOT NULL,
    description character varying(255),
    status character varying(50) DEFAULT 'on progress'::character varying,
    created_at date DEFAULT CURRENT_DATE,
    CONSTRAINT tasks_status_check CHECK (((status)::text = ANY ((ARRAY['done'::character varying, 'on progress'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(30),
    email character varying(30),
    password character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'user'::character varying,
    profile_pic_key character varying(255)
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: projects projects_task_cache_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_task_cache_version BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.bump_project_task_cache_version();


--
-- Name: tasks tasks_invalidate_project_cache; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_invalidate_project_cache AFTER INSERT OR DELETE OR UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.invalidate_project_tasks();


--
-- Name: projects fk_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- PostgreSQL database dump complete
--

\unrestrict NOdjE1NeAs4g17zfknNnA2t5rObXHMub0gSSRL6RrGkPahhFtjcNe9hA0e4BU3E

