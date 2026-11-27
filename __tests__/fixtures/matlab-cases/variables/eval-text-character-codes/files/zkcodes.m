function zkcodes()
eval(['disp(1);' 10 'zkcdlf(2)']);
eval(['disp(1);' 13 'zkcdcr(2)']);
eval(['disp(1);' newline 'zkcdnl(2)']);
eval(['disp(1);' char(10) 'zkcdch(2)']);
eval(['zkcdlead(1);' 10 'disp(2)']);
eval(['zkcd' 49 '(2)']);
eval(['zkce' 49.5 '(2)']);
eval(['zkcf' 49.7 '(2)']);
eval(['disp(1);' 10.5 'zkcg(5)']);
eval(['disp(1)' 13 'zkch(6)']);
eval(['disp(1)' 9 'zkci(7)']);
eval(['zkcpa(1);' 10 ...
  'disp(2)']);
eval(['disp(1);' 1 'zkcm(2)']);
eval(['zkcj(1);' 1 'zkck(2)']);
eval(['zkcn(1);' 0 '; zkco(2)']);
eval(['zkcp(1);' 0.5 '; zkcq(2)']);
eval(['zkcr(1);' 1.5 'zkcs(2)']);
eval(['zkct(1);' char(1) 'zkcu(2)']);
eval(['zkcv(1);' 233 'zkcw(2)']);
eval(['disp(''' 233 '''); zkcx(1)']);
eval(['zkcy(1);' 11 'zkcz(2)']);
eval(['zkcgg' char(49.5) '(1)']);
eval(['zkc0a(1);' char(0) '; zkc0b(2)']);
eval(['zkcfa(1);' 12 'zkcfb(2)']);
eval(['zkcsa(1); disp(''a' 0 'b''); zkcsb(2)']);
eval(['disp ' 233 '; zkcca(1)']);
eval(['zkcta(1); disp a' 0 'b; zkctb(3)']);
eval(['zkcua(1); % a' 0 newline 'zkcub(2)']);
eval(['zkcgz' 0 '(1)']);
end
