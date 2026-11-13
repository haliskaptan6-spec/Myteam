-- SAHA Video Odası: "permission denied for table messages" düzeltmesi
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, update, delete on public.msg_seen to authenticated;
grant execute on function public.saha_is_admin() to authenticated;
