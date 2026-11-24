function caller()
eval('eval([''f(1);'' ''f(2)''])');
eval('eval(sprintf(''f(%d); f(%d)'', 3, 4))');
end
