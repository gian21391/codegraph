classdef Model < handle
    properties (Dependent)
        Total
    end
    methods
        function v = get.Total(obj)
            v = 1;
        end
    end
end
