function go()
s = Suite();
report = Report();
report = run(s, report);
send(report);
end
